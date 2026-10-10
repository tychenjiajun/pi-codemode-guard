// ---------------------------------------------------------------------------
// TanStack AI code mode dialect -> Pi codemode dialect
// ---------------------------------------------------------------------------
//
// `@tanstack/ai-code-mode` exposes a different program API than Pi:
//
//   TanStack AI                                Pi
//   ─────────────────────────────────────────  ──────────────────────────────
//   { typescriptCode: "..." }                  { code: "..." }
//   external_getWeather({ location })          tools.getWeather({ location })
//   type annotations, interfaces, `as`         plain JavaScript
//
// Each tool becomes a global `external_<name>` async function in the TanStack
// sandbox; Pi instead addresses tools through `tools.<identifier>`. The code is
// TypeScript, so `compileTanstackDialect` is always preceded by
// `stripTypeScriptSyntax`, and the caller passes Pi's live tool catalog so the
// binding name can be resolved through `resolveToolPath`.
//
// Everything else (top-level `return`, `await`, `console.log`, `Promise.all`)
// is already valid Pi.

import { buildCatalog, resolveToolPath, walk, type Replacement } from "./catalog.ts";
import { childNodes, parseScript, type AstNode } from "./parse.ts";

/** TanStack's binding prefix for tools exposed inside the sandbox. */
export const TANSTACK_BINDING_PREFIX = "external_";

export interface TanstackCompileOptions {
  /** Pi tool names, from `pi.getAllTools()`. Used to resolve `external_<name>`. */
  readonly tools?: readonly string[];
}

export interface TanstackCompileResult {
  readonly code: string;
  readonly changed: boolean;
  readonly rewrites: number;
  readonly warnings: readonly string[];
}

/** Keys and labels are not references, so rewriting them would corrupt the script. */
function isReferenceIdentifier(node: AstNode, parents: readonly AstNode[]): boolean {
  const parent = parents[parents.length - 1];
  if (!parent) return true;
  if (parent.type === "MemberExpression" && parent.property === node) return false;
  if (parent.type === "Property" && parent.key === node) return false;
  if ((parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parent.key === node) return false;
  if (parent.type === "LabeledStatement" && parent.label === node) return false;
  if ((parent.type === "BreakStatement" || parent.type === "ContinueStatement") && parent.label === node) return false;
  return true;
}

/** Whether `node` sits inside `container`'s source range. */
function within(node: AstNode, container: AstNode | undefined | null): boolean {
  if (!container) return false;
  return node.start >= container.start && node.end <= container.end;
}

function isFunctionScope(node: AstNode): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** Whether a binding pattern (parameter, declarator id) binds `name`. */
function patternBinds(pattern: AstNode | undefined | null, name: string): boolean {
  if (!pattern) return false;
  let found = false;
  const visit = (node: AstNode | undefined | null): void => {
    if (!node || found) return;
    switch (node.type) {
      case "Identifier":
        if (node.name === name) found = true;
        break;
      case "ObjectPattern":
        for (const property of (node.properties as AstNode[] | undefined) ?? []) {
          visit(property.type === "Property" ? (property.value as AstNode) : (property.argument as AstNode));
        }
        break;
      case "ArrayPattern":
        for (const element of (node.elements as (AstNode | null)[] | undefined) ?? []) visit(element);
        break;
      case "AssignmentPattern":
        visit(node.left as AstNode);
        break;
      case "RestElement":
        visit(node.argument as AstNode);
        break;
      default:
        break;
    }
  };
  visit(pattern);
  return found;
}

/**
 * Whether a function/Program scope declares `name` anywhere in its own body:
 * its parameters, `var`/`let`/`const` declarators, and nested function/class
 * declarations — without descending into nested functions (their bindings
 * belong to their own scopes). Declarations in sibling blocks are included,
 * which over-approximates slightly — the safe direction, since an
 * over-suppressed reference is left alone, never corrupted.
 */
function scopeDeclares(scope: AstNode, name: string): boolean {
  if (scope.type === "FunctionDeclaration") {
    const id = scope.id as AstNode | undefined;
    if (id?.type === "Identifier" && id.name === name) return true;
  }
  if (isFunctionScope(scope)) {
    for (const param of (scope.params as AstNode[] | undefined) ?? []) {
      if (patternBinds(param, name)) return true;
    }
  }
  let found = false;
  const visit = (node: AstNode): void => {
    if (found) return;
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      const id = node.id as AstNode | undefined;
      if (id?.type === "Identifier" && id.name === name) found = true;
      return; // nested scope — only the declaration name binds here
    }
    if (
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "ClassExpression"
    ) {
      return;
    }
    if (node.type === "VariableDeclarator") {
      if (patternBinds(node.id as AstNode, name)) found = true;
      return;
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(isFunctionScope(scope) ? ((scope.body as AstNode) ?? scope) : scope);
  return found;
}

/**
 * Whether `name` is shadowed at `node`'s position: declared by an enclosing
 * function/Program scope, bound by an enclosing parameter or catch parameter,
 * or being declared right there (a declaration site is never a reference).
 * Scope-aware, so a binding in one function does not suppress an unrelated
 * rewrite somewhere else in the script.
 */
function isShadowedAt(node: AstNode, parents: readonly AstNode[], name: string): boolean {
  for (let i = parents.length - 1; i >= 0; i--) {
    const ancestor = parents[i]!;
    if (ancestor.type === "VariableDeclarator") {
      if (within(node, ancestor.id as AstNode | undefined)) return true;
      continue;
    }
    if (ancestor.type === "CatchClause") {
      if (within(node, ancestor.param as AstNode | undefined)) return true;
      if (patternBinds(ancestor.param as AstNode, name)) return true; // node is inside the catch body
      continue;
    }
    if (
      ancestor.type === "FunctionDeclaration" ||
      ancestor.type === "FunctionExpression" ||
      ancestor.type === "ArrowFunctionExpression"
    ) {
      if (within(node, ancestor.id as AstNode | undefined)) return true;
      if (scopeDeclares(ancestor, name)) return true;
      continue;
    }
    if (ancestor.type === "ClassDeclaration" && within(node, ancestor.id as AstNode | undefined)) return true;
    if (ancestor.type === "Program" && scopeDeclares(ancestor, name)) return true;
  }
  return false;
}

/**
 * Rewrite TanStack's `external_<tool>` bindings into Pi's `tools.<identifier>`.
 * A no-op on already-Pi code. Call it before the await pass so rewritten tool
 * calls still get their missing `await`.
 */
export function compileTanstackDialect(
  code: string,
  options: TanstackCompileOptions = {},
): TanstackCompileResult {
  const ast = parseScript(code);
  if (!ast) return { code, changed: false, rewrites: 0, warnings: [] };

  const names = options.tools ?? [];
  const catalog = buildCatalog(names);
  const replacements: Replacement[] = [];
  const warnings: string[] = [];
  let rewrites = 0;

  walk(ast, [], (node, parents) => {
    if (node.type !== "Identifier") return;
    const name = node.name as string;
    if (!name.startsWith(TANSTACK_BINDING_PREFIX) || name.length === TANSTACK_BINDING_PREFIX.length) return;
    if (!isReferenceIdentifier(node, parents) || isShadowedAt(node, parents, name)) return;

    const binding = name.slice(TANSTACK_BINDING_PREFIX.length);
    const resolution = resolveToolPath([binding], catalog);
    if (resolution.matched === undefined && names.length > 0) {
      warnings.push(
        `could not resolve TanStack binding \`${name}\` in the Pi catalog; mapped to \`tools.${resolution.identifier}\``,
      );
    }
    const parent = parents[parents.length - 1];
    const shorthand =
      parent?.type === "Property" && parent.shorthand === true && parent.value === node;
    // Acorn gives shorthand properties distinct key/value nodes at the same
    // range: rewriting the value alone would leave `{ tools.foo }`, which is
    // not valid JavaScript, so emit `external_foo: tools.foo` instead.
    const text = shorthand ? `${name}: tools.${resolution.identifier}` : `tools.${resolution.identifier}`;
    if (code.slice(node.start, node.end) !== text) {
      replacements.push({ start: node.start, end: node.end, text });
      rewrites++;
    }
  });

  if (replacements.length === 0) return { code, changed: false, rewrites: 0, warnings };

  replacements.sort((a, b) => b.start - a.start);
  let result = code;
  for (const replacement of replacements) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return { code: result, changed: true, rewrites, warnings };
}