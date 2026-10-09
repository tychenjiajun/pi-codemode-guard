// ---------------------------------------------------------------------------
// Missing-`await` repair
// ---------------------------------------------------------------------------
//
// Every codemode tool call and every async lookup helper returns a promise.
// Models frequently forget the `await`, and because the output helpers
// JSON-serialize non-strings, the pending promise reaches the model as `{}`
// (this is exactly pi issue #10555: `searchTools()` unawaited prints `{}`).
//
// The guard parses the script and inserts `await` (or `(await ...)` when the
// result is immediately indexed/called) in front of:
//
//   * `tools.<name>(...)`                      — every tool call
//   * `searchTools(...)`, `describeTool(...)`, `describeNamespace(...)`
//   * `models.<asyncMethod>(...)`
//
// It deliberately leaves calls alone when adding `await` would change
// meaning or break syntax: calls that are already awaited, calls passed to
// `Promise.all`/`allSettled`/`race`/`any`, promises chained with
// `.then`/`.catch`/`.finally`, and calls inside a non-async function.

import { childNodes, isFunctionNode, parseScript, type AstNode } from "./parse.ts";

/** Promise-returning globals. */
export const ASYNC_GLOBALS = new Set(["searchTools", "describeTool", "describeNamespace"]);

/** Objects whose every method returns a promise. */
export const ASYNC_OBJECTS = new Set(["tools"]);

/** Promise-returning `models` methods. */
export const MODELS_ASYNC_METHODS = new Set([
  "getModelsOfType",
  "getAvailableOfType",
  "getModelOfType",
  "classify",
  "generateImages",
]);

const PROMISE_COMBINATORS = new Set(["all", "allSettled", "race", "any"]);
const PROMISE_PASSTHROUGH_METHODS = new Set(["then", "catch", "finally"]);

export interface AwaitInjectionResult {
  readonly code: string;
  readonly inserted: number;
}

interface MemberInfo {
  readonly object?: string;
  readonly property: string;
  readonly computed: boolean;
}

interface Insertion {
  readonly pos: number;
  readonly text: string;
  /** Lower first at equal positions, so a wrapping `(await ` stays inside a plain `await `. */
  readonly order: number;
}

interface WalkState {
  readonly asyncStack: boolean[];
  readonly promiseContainers: Set<AstNode>;
  readonly insertions: Insertion[];
}

function memberInfo(node: AstNode): MemberInfo | undefined {
  if (node.type === "Identifier") {
    return { property: node.name as string, computed: false };
  }
  if (node.type === "MemberExpression") {
    const object = node.object as AstNode;
    if (object.type !== "Identifier") return undefined;
    let property: string | undefined;
    if (node.computed !== true && (node.property as AstNode).type === "Identifier") {
      property = (node.property as AstNode).name as string;
    } else if (
      node.computed === true &&
      (node.property as AstNode).type === "Literal" &&
      typeof (node.property as AstNode).value === "string"
    ) {
      property = (node.property as AstNode).value as string;
    }
    if (property === undefined) return undefined;
    return { object: object.name as string, property, computed: node.computed === true };
  }
  return undefined;
}

/** Whether a call target is one of the promise-returning globals or methods. */
export function isAsyncCallTarget(node: AstNode): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee as AstNode;
  // A directly-invoked async function expression, such as the OpenCode search
  // shim `(async (req) => { ... })(req)`, is a promise too.
  if (callee.type === "ArrowFunctionExpression" || callee.type === "FunctionExpression") {
    return callee.async === true;
  }
  const info = memberInfo(callee);
  if (!info) return false;
  if (info.object === undefined) return ASYNC_GLOBALS.has(info.property);
  if (ASYNC_OBJECTS.has(info.object)) return true;
  if (info.object === "models" && MODELS_ASYNC_METHODS.has(info.property)) return true;
  return false;
}

function nearestFunctionIsAsync(state: WalkState): boolean {
  const innermost = state.asyncStack[state.asyncStack.length - 1];
  return innermost === undefined || innermost;
}

function registerPromiseContainer(node: AstNode, state: WalkState): void {
  const info = memberInfo(node.callee as AstNode);
  if (!info || info.object !== "Promise" || !PROMISE_COMBINATORS.has(info.property)) return;
  const first = (node.arguments as AstNode[])[0];
  if (first && first.type === "ArrayExpression") state.promiseContainers.add(first);
}

function shouldAwait(call: AstNode, parents: readonly AstNode[], state: WalkState): boolean {
  if (!isAsyncCallTarget(call)) return false;
  if (!nearestFunctionIsAsync(state)) return false;

  const parent = parents[parents.length - 1];
  if (!parent) return true;

  // Already awaited: `await tools.read(...)`.
  if (parent.type === "AwaitExpression") return false;

  // Promise combinator: `Promise.all([tools.read(...)])`.
  if (parents.some((ancestor) => state.promiseContainers.has(ancestor))) return false;

  // Chain members: `tools.read(...).then(...)`.
  if (parent.type === "MemberExpression" && parent.object === call) {
    const property = parent.property as AstNode;
    if (
      parent.computed !== true &&
      property.type === "Identifier" &&
      PROMISE_PASSTHROUGH_METHODS.has(property.name as string)
    ) {
      return false;
    }
  }

  return true;
}

function needsParentheses(call: AstNode, parent: AstNode | undefined): boolean {
  if (!parent) return false;
  if (parent.type === "MemberExpression") return parent.object === call;
  if (parent.type === "CallExpression") return parent.callee === call;
  if (parent.type === "NewExpression") return parent.callee === call;
  if (parent.type === "TaggedTemplateExpression") return parent.tag === call;
  return false;
}

function walk(node: AstNode, parents: readonly AstNode[], state: WalkState): void {
  const isFunction = isFunctionNode(node);
  if (isFunction) state.asyncStack.push(node.async === true);

  if (node.type === "CallExpression") {
    registerPromiseContainer(node, state);
    const parent = parents[parents.length - 1];
    // Optional chaining wraps the chain in a ChainExpression; leave it alone.
    if (parent?.type !== "ChainExpression" && shouldAwait(node, parents, state)) {
      const wrap = needsParentheses(node, parent);
      state.insertions.push({ pos: node.start, text: wrap ? "(await " : "await ", order: wrap ? 0 : 2 });
      if (wrap) state.insertions.push({ pos: node.end, text: ")", order: 1 });
    }
  }

  const nextParents = [...parents, node];
  for (const child of childNodes(node)) walk(child, nextParents, state);

  if (isFunction) state.asyncStack.pop();
}

/**
 * Insert missing `await` keywords. Returns `undefined` when the script does not
 * parse; the caller then leaves the source unchanged.
 */
export function injectAwait(code: string): AwaitInjectionResult | undefined {
  const ast = parseScript(code);
  if (!ast) return undefined;

  const state: WalkState = { asyncStack: [], promiseContainers: new Set(), insertions: [] };
  walk(ast, [], state);

  if (state.insertions.length === 0) return { code, inserted: 0 };

  const insertions = [...state.insertions].sort((a, b) => b.pos - a.pos || a.order - b.order);
  let result = code;
  for (const insertion of insertions) {
    result = result.slice(0, insertion.pos) + insertion.text + result.slice(insertion.pos);
  }
  return { code: result, inserted: insertions.filter((insertion) => insertion.order !== 1).length };
}
