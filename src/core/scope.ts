// ---------------------------------------------------------------------------
// Scope and binding analysis
// ---------------------------------------------------------------------------
//
// Several passes must tell a reference to Pi's sandbox globals (`tools`,
// `codemode`, a bare tool name) from a name the script binds itself. That needs
// the same scope walk everywhere, so it lives here:
//
//   * `collectBoundNames` — every name the script binds, anywhere
//   * `isShadowedAt`      — whether `name` is bound by an enclosing scope
//   * `isReferenceIdentifier` / `isDeclarationPosition` — whether an identifier
//     is a value reference or a binding/key/label
//
// Pure: it reads the AST and returns booleans, never rewrites.

import { childNodes, isFunctionNode, walk, type AstNode } from "./parse.ts";

/** Names bound by the script itself, so a local object is not mistaken for a tool. */
export function collectBoundNames(ast: AstNode): Set<string> {
  const bound = new Set<string>();
  const addPattern = (pattern: AstNode | undefined | null): void => {
    if (!pattern) return;
    walk(pattern, [], (node) => {
      if (node.type === "Identifier") bound.add(node.name as string);
    });
  };

  walk(ast, [], (node) => {
    switch (node.type) {
      case "VariableDeclarator":
        addPattern(node.id as AstNode | undefined);
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        for (const param of (node.params as AstNode[] | undefined) ?? []) addPattern(param);
        if (node.type === "FunctionDeclaration") addPattern(node.id as AstNode | undefined);
        break;
      case "ClassDeclaration":
        addPattern(node.id as AstNode | undefined);
        break;
      case "ImportSpecifier":
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
        addPattern(node.local as AstNode | undefined);
        break;
      case "CatchClause":
        addPattern(node.param as AstNode | undefined);
        break;
    }
  });

  return bound;
}

/** Whether `node` sits inside `container`'s source range. */
function within(node: AstNode, container: AstNode | undefined | null): boolean {
  if (!container) return false;
  return node.start >= container.start && node.end <= container.end;
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
  if (isFunctionNode(scope)) {
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
  visit(isFunctionNode(scope) ? ((scope.body as AstNode) ?? scope) : scope);
  return found;
}

/**
 * Whether `name` is shadowed at `node`'s position: declared by an enclosing
 * function/Program scope, bound by an enclosing parameter or catch parameter,
 * or being declared right there (a declaration site is never a reference).
 * Scope-aware, so a binding in one function does not suppress an unrelated
 * rewrite somewhere else in the script.
 */
export function isShadowedAt(node: AstNode, parents: readonly AstNode[], name: string): boolean {
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
    if (isFunctionNode(ancestor)) {
      if (within(node, ancestor.id as AstNode | undefined)) return true;
      if (scopeDeclares(ancestor, name)) return true;
      continue;
    }
    if (ancestor.type === "ClassDeclaration" && within(node, ancestor.id as AstNode | undefined)) return true;
    if (ancestor.type === "Program" && scopeDeclares(ancestor, name)) return true;
  }
  return false;
}

/** Keys and labels are not references, so rewriting them would corrupt the script. */
export function isReferenceIdentifier(node: AstNode, parents: readonly AstNode[]): boolean {
  const parent = parents[parents.length - 1];
  if (!parent) return true;
  if (parent.type === "MemberExpression" && parent.property === node) return false;
  if (parent.type === "Property" && parent.key === node) return false;
  if ((parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parent.key === node) return false;
  if (parent.type === "LabeledStatement" && parent.label === node) return false;
  if ((parent.type === "BreakStatement" || parent.type === "ContinueStatement") && parent.label === node) return false;
  return true;
}

/**
 * Whether the identifier is written in a declaration position — a variable or
 * function/class name, a function or catch parameter, or a property key — so
 * it is not a dialect binding reference.
 */
export function isDeclarationPosition(node: AstNode, parents: readonly AstNode[]): boolean {
  const parent = parents[parents.length - 1];
  if (!parent) return false;
  if (parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") {
    if (parent.key === node) return true;
  }
  for (let i = parents.length - 1; i >= 0; i--) {
    const ancestor = parents[i]!;
    if (ancestor.type === "VariableDeclarator" && within(node, ancestor.id as AstNode | undefined)) return true;
    if (ancestor.type === "FunctionDeclaration" && within(node, ancestor.id as AstNode | undefined)) return true;
    if (ancestor.type === "ClassDeclaration" && within(node, ancestor.id as AstNode | undefined)) return true;
    if (ancestor.type === "CatchClause" && within(node, ancestor.param as AstNode | undefined)) return true;
    if (isFunctionNode(ancestor)) {
      if ((ancestor.params as AstNode[]).some((param) => within(node, param))) return true;
    }
  }
  return false;
}
