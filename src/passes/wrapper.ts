// ---------------------------------------------------------------------------
// Wrapper parameter renaming
// ---------------------------------------------------------------------------
//
// Pi runs every codemode script as the body of a wrapper function:
//
//   (async (tools, console) => { <script> })
//
// `tools` and `console` are parameters of that wrapper, so a *lexical*
// declaration of either name at the top level of the script is a syntax error
// in the sandbox — QuickJS rejects
//
//   const tools = await searchTools("wiki", { limit: 30 });
//
// with `SyntaxError: invalid redefinition of parameter name` at parse time,
// before a single tool call runs (observed in a real session; the model then
// retried with `const found = ...`, which worked). Everything else is legal
// and left alone: `var`/`function` declarations (var-scoped, they redeclare
// the parameter binding) and declarations in nested scopes — `for (const
// tools of …)`, blocks, nested functions, and an async IIFE the unwrap pass
// has not removed all shadow the parameter without conflicting.
//
// The guard renames the colliding top-level binding and every reference that
// resolves to it (`tools` -> `tools_`), so the script runs with exactly its
// own semantics and the wrapper's real `tools`/`console` are never touched.
// The fresh name is the first `name_` chain that appears nowhere in the
// script, so no reference can be captured, and the pass is idempotent: once
// renamed, the top level no longer declares the parameter name.

import { PI_WRAPPER_PARAMS } from "../core/pi-globals.ts";
import { childNodes, isFunctionNode, parseScript, walk, type AstNode } from "../core/parse.ts";
import { applyReplacements, selectReplacements, type Replacement } from "../core/replacements.ts";
import { isReferenceIdentifier, patternBinds } from "../core/scope.ts";

const WRAPPER_PARAMS = new Set<string>(PI_WRAPPER_PARAMS);

export interface WrapperRenameResult {
  readonly code: string;
  /** Number of colliding top-level bindings renamed. */
  readonly renamed: number;
}

type BindingSink = (node: AstNode, prop: AstNode | undefined) => void;

/**
 * Walk a binding pattern, calling `sink` for every binding identifier with the
 * enclosing shorthand `Property` (or `undefined`): `const { tools } = o` binds
 * through the property, `const { tools: t } = o` binds `t` directly. Property
 * *keys* are not bindings and are never visited; default expressions
 * (`{ x = tools }`) live in the value side and are references, not bindings.
 */
function walkPattern(node: AstNode, prop: AstNode | undefined, sink: BindingSink): void {
  switch (node.type) {
    case "Identifier":
      sink(node, prop);
      return;
    case "ObjectPattern":
      for (const property of (node.properties as AstNode[] | undefined) ?? []) {
        if (property.type === "RestElement") {
          walkPattern(property.argument as AstNode, undefined, sink);
        } else if (property.type === "Property") {
          walkPattern(property.value as AstNode, property.shorthand === true ? property : undefined, sink);
        }
      }
      return;
    case "ArrayPattern":
      for (const element of (node.elements as (AstNode | null)[] | undefined) ?? []) {
        if (element) walkPattern(element, undefined, sink);
      }
      return;
    case "AssignmentPattern":
      walkPattern(node.left as AstNode, prop, sink);
      return;
    case "RestElement":
      walkPattern(node.argument as AstNode, prop, sink);
      return;
    default:
      return;
  }
}

/** Whether a binding pattern binds `name`. */
function patternBindsName(pattern: AstNode | undefined, name: string): boolean {
  if (!pattern) return false;
  let found = false;
  walkPattern(pattern, undefined, (node) => {
    if (node.name === name) found = true;
  });
  return found;
}

/** The wrapper-parameter names declared lexically at the top level of the script. */
function topLevelCollisions(ast: AstNode): Set<string> {
  const targets = new Set<string>();
  for (const statement of (ast.body as AstNode[] | undefined) ?? []) {
    if (statement.type === "ClassDeclaration") {
      const id = statement.id as AstNode | undefined;
      if (id?.type === "Identifier" && WRAPPER_PARAMS.has(id.name as string)) targets.add(id.name as string);
      continue;
    }
    if (statement.type !== "VariableDeclaration" || statement.kind === "var") continue;
    for (const declarator of (statement.declarations as AstNode[] | undefined) ?? []) {
      walkPattern(declarator.id as AstNode, undefined, (node) => {
        const name = node.name as string;
        if (WRAPPER_PARAMS.has(name)) targets.add(name);
      });
    }
  }
  return targets;
}

/** Whether a list of statements (a block body, a switch case) lexically binds `name`. */
function statementsBind(statements: readonly AstNode[] | undefined, name: string): boolean {
  for (const statement of statements ?? []) {
    if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
      const id = statement.id as AstNode | undefined;
      if (id?.type === "Identifier" && id.name === name) return true;
      continue;
    }
    if (statement.type !== "VariableDeclaration" || statement.kind === "var") continue;
    for (const declarator of (statement.declarations as AstNode[] | undefined) ?? []) {
      if (patternBindsName(declarator.id as AstNode, name)) return true;
    }
  }
  return false;
}

/** Whether a `var` declaration of `name` exists anywhere in `scope` (not nested functions). */
function varBinds(scope: AstNode, name: string): boolean {
  let found = false;
  const scan = (node: AstNode): void => {
    if (found || (node !== scope && isFunctionNode(node))) return;
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      for (const declarator of (node.declarations as AstNode[] | undefined) ?? []) {
        if (patternBindsName(declarator.id as AstNode, name)) {
          found = true;
          return;
        }
      }
    }
    for (const child of childNodes(node)) scan(child);
  };
  scan(scope);
  return found;
}

/** Whether a function scope binds `name` itself: a parameter, a body-level lexical declaration, or a `var`. */
function functionScopeBinds(fn: AstNode, name: string): boolean {
  for (const param of (fn.params as AstNode[] | undefined) ?? []) {
    if (patternBinds(param, name)) return true;
  }
  const body = fn.body as AstNode | undefined;
  if (!body || body.type !== "BlockStatement") return false;
  return statementsBind(body.body as AstNode[], name) || varBinds(body, name);
}

/**
 * Whether a reference at `parents` resolves to the script's top-level binding
 * of `name`: no enclosing function, block, switch, for, catch or class
 * static-block scope binds the name on the way out. Iterates innermost-first,
 * the same way `isShadowedAt` does. Every ES scope form that can bind a name
 * lexically is listed in the `switch` below — adding one there and forgetting
 * it here captures a shadowed reference without changing the script's shape,
 * so the omission fails silently.
 */
function resolvesToTopLevelBinding(name: string, parents: readonly AstNode[]): boolean {
  for (let i = parents.length - 1; i >= 0; i--) {
    const ancestor = parents[i]!;
    if (isFunctionNode(ancestor)) {
      // A named function *expression* also binds its own name in its scope.
      const id = ancestor.id as AstNode | undefined;
      if (ancestor.type === "FunctionExpression" && id?.type === "Identifier" && id.name === name) return false;
      if (functionScopeBinds(ancestor, name)) return false;
      continue;
    }
    switch (ancestor.type) {
      case "Program":
        return true;
      case "CatchClause":
        if (patternBinds(ancestor.param as AstNode | undefined, name)) return false;
        continue;
      case "BlockStatement":
        if (statementsBind(ancestor.body as AstNode[], name)) return false;
        continue;
      case "SwitchStatement":
        for (const switchCase of (ancestor.cases as AstNode[] | undefined) ?? []) {
          if (statementsBind(switchCase.consequent as AstNode[] | undefined, name)) return false;
        }
        continue;
      case "ForStatement": {
        const init = ancestor.init as AstNode | undefined;
        if (init?.type === "VariableDeclaration" && init.kind !== "var" && statementsBind([init], name)) return false;
        continue;
      }
      case "ForOfStatement":
      case "ForInStatement": {
        const left = ancestor.left as AstNode;
        if (left.type === "VariableDeclaration" && left.kind !== "var" && statementsBind([left], name)) return false;
        continue;
      }
      case "StaticBlock":
        // A class static block is its own var/lexical scope, and the sandbox
        // (verified in pi's QuickJS) supports it: `class A { static { const
        // tools = 2 } }` is legal next to the wrapper parameter. Missing this
        // scope would capture the block's own `tools` for the top-level one and
        // silently change the program's output.
        if (statementsBind(ancestor.body as AstNode[], name) || varBinds(ancestor, name)) return false;
        continue;
      default:
        continue;
    }
  }
  return true;
}

/**
 * Whether the identifier is itself a binding — a declarator id, a parameter,
 * a catch parameter, or a function/class declaration name — rather than a
 * reference. Precise (unlike the declaration-position check shared with the
 * dialect passes): a reference inside a *default expression* of a pattern or
 * parameter (`function f(a = tools) {}`) is not a binding.
 */
function isBindingIdentifier(node: AstNode, parents: readonly AstNode[]): boolean {
  for (let i = parents.length - 1; i >= 0; i--) {
    const ancestor = parents[i]!;
    const child = i + 1 < parents.length ? parents[i + 1]! : node;
    if (ancestor.type === "VariableDeclarator") {
      if (child === (ancestor.id as AstNode | undefined) && patternBindsName(ancestor.id as AstNode, node.name as string)) {
        // Narrow to this exact identifier (a shorthand key has the same name).
        let exact = false;
        walkPattern(ancestor.id as AstNode, undefined, (binding) => {
          if (binding === node) exact = true;
        });
        return exact;
      }
      continue;
    }
    if (ancestor.type === "CatchClause") {
      if (child === (ancestor.param as AstNode | undefined) && ancestor.param) {
        let exact = false;
        walkPattern(ancestor.param as AstNode, undefined, (binding) => {
          if (binding === node) exact = true;
        });
        return exact;
      }
      continue;
    }
    if (isFunctionNode(ancestor)) {
      if (((ancestor.params as AstNode[] | undefined) ?? []).includes(child)) {
        let exact = false;
        walkPattern(child, undefined, (binding) => {
          if (binding === node) exact = true;
        });
        return exact;
      }
      continue;
    }
    if (
      (ancestor.type === "FunctionDeclaration" || ancestor.type === "ClassDeclaration") &&
      child === (ancestor.id as AstNode | undefined)
    ) {
      return true; // the declaration's own name
    }
  }
  return false;
}

/** `{ tools }` / `{ tools = 1 }` -> `tools: tools_` / `tools: tools_ = 1` (the property name is kept). */
function shorthandRename(prop: AstNode, code: string, name: string, fresh: string): string {
  const value = prop.value as AstNode;
  const suffix = value.type === "AssignmentPattern" ? code.slice((value.left as AstNode).end, prop.end) : "";
  return `${name}: ${fresh}${suffix}`;
}

/**
 * Rename top-level lexical declarations that collide with pi's wrapper
 * parameters (`tools`, `console`) and every reference that resolves to them.
 * Returns `undefined` when the script does not parse.
 */
export function renameWrapperParams(code: string): WrapperRenameResult | undefined {
  const ast = parseScript(code);
  if (!ast) return undefined;

  const targets = topLevelCollisions(ast);
  if (targets.size === 0) return { code, renamed: 0 };

  // The fresh name must appear nowhere in the script — not as a binding, not
  // as a reference — so no renamed reference can be captured by an inner scope.
  const used = new Set<string>();
  walk(ast, [], (node) => {
    if (node.type === "Identifier") used.add(node.name as string);
  });
  const freshNames = new Map<string, string>();
  for (const name of targets) {
    let fresh = `${name}_`;
    while (used.has(fresh)) fresh += "_";
    freshNames.set(name, fresh);
  }

  const replacements: Replacement[] = [];

  // (a) The declaration sites.
  for (const statement of (ast.body as AstNode[] | undefined) ?? []) {
    if (statement.type === "ClassDeclaration") {
      const id = statement.id as AstNode | undefined;
      const name = id?.type === "Identifier" ? (id.name as string) : undefined;
      if (id && name && targets.has(name)) {
        replacements.push({ start: id.start, end: id.end, text: freshNames.get(name)! });
      }
      continue;
    }
    if (statement.type !== "VariableDeclaration" || statement.kind === "var") continue;
    for (const declarator of (statement.declarations as AstNode[] | undefined) ?? []) {
      walkPattern(declarator.id as AstNode, undefined, (node, prop) => {
        const name = node.name as string;
        if (!targets.has(name)) return;
        const fresh = freshNames.get(name)!;
        if (prop) {
          replacements.push({ start: prop.start, end: prop.end, text: shorthandRename(prop, code, name, fresh) });
        } else {
          replacements.push({ start: node.start, end: node.end, text: fresh });
        }
      });
    }
  }

  // (b) Every reference that resolves to the top-level binding.
  walk(ast, [], (node, parents) => {
    if (node.type !== "Identifier") return;
    const name = node.name as string;
    if (!targets.has(name)) return;
    const parent = parents[parents.length - 1];
    if (parent) {
      const keyed =
        (parent.type === "Property" ||
          parent.type === "MethodDefinition" ||
          parent.type === "PropertyDefinition") &&
        parent.key === node;
      if (keyed && parent.computed !== true) return; // a static key names a property, not a binding
      if ((parent.type === "FunctionExpression" || parent.type === "ClassExpression") && parent.id === node) return;
      if (!keyed && !isReferenceIdentifier(node, parents)) return; // labels, member properties
    }
    if (isBindingIdentifier(node, parents)) return;
    if (!resolvesToTopLevelBinding(name, parents)) return;

    const fresh = freshNames.get(name)!;
    if (parent?.type === "Property" && parent.shorthand === true && parent.value === node) {
      replacements.push({ start: parent.start, end: parent.end, text: shorthandRename(parent, code, name, fresh) });
      return;
    }
    replacements.push({ start: node.start, end: node.end, text: fresh });
  });

  // The property-level replacement subsumes the identifier inside it; identical
  // ranges are deduplicated by the shared selection rule.
  const selected = selectReplacements(replacements);
  if (selected.length === 0) return { code, renamed: 0 };
  return { code: applyReplacements(code, selected), renamed: targets.size };
}
