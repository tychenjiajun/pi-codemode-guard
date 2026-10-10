// ---------------------------------------------------------------------------
// OpenCode dialect -> Pi codemode dialect
// ---------------------------------------------------------------------------
//
// OpenCode's `@opencode-ai/codemode` (packages/codemode) runs a restricted
// JavaScript subset through a tree-walking interpreter. Its envelope is the
// same as Pi's - `{ code: string }` - but the program API differs:
//
//   OpenCode                                  Pi
//   ────────────────────────────────────────  ────────────────────────────────
//   tools.orders.lookup({ id })               tools.<flat identifier>({ ... })
//   tools.context7["resolve-library-id"]({})  tools.context7_resolve_library_id({})
//   await tools.$codemode.search({ query })   await searchTools(query, { ... })
//   Object.keys(tools)                        ALL_TOOLS.map((t) => t.name)
//   console.log -> `logs[]`                   console.log -> <console_output>
//   return value -> `{ ok, value }`           return value -> text output
//
// This module detects that dialect and rewrites the parts that would otherwise
// throw at runtime in Pi. Everything else (return, console.log, Promise.all,
// top-level await) is already valid Pi.
//
// The `tools.a.b` -> `tools.<identifier>` mapping depends on pi's live tool
// catalog, so the caller passes `tools` (the names from `pi.getAllTools()`).
// Without a catalog the pass still runs, with a best-effort flatten and a
// warning.

import { buildCatalog, collectBoundNames, collectChain, resolveToolPath, walk, type Replacement } from "./catalog.ts";
import { toCodemodeIdentifier } from "./identifiers.ts";
import { parseScript, type AstNode } from "./parse.ts";

export { detectCodemodeDialect } from "./dialect.ts";
export type { CodemodeDialect, DialectDetection } from "./dialect.ts";
export { normalizeToolKey } from "./catalog.ts";

export interface OpencodeCompileOptions {
  /** Pi tool names, from `pi.getAllTools()`. Used to resolve namespace paths. */
  readonly tools?: readonly string[];
}

export interface OpencodeCompileResult {
  readonly code: string;
  readonly changed: boolean;
  readonly rewrites: number;
  readonly warnings: readonly string[];
}

/** A runtime shim for `tools.$codemode.search(...)`, matching OpenCode's result shape.
 * Fetches one extra result so `remaining`/`next` stay live past a capped page. */
export const OPENCODE_SEARCH_SHIM = `(async (__cm_req) => {
  const __cm_query = __cm_req?.query ?? "";
  const __cm_namespace = __cm_req?.namespace;
  const __cm_offset = __cm_req?.offset ?? 0;
  const __cm_limit = __cm_req?.limit ?? 10;
  const __cm_found = (await searchTools(__cm_query, { limit: __cm_offset + __cm_limit + 1, ...(__cm_namespace === undefined ? {} : { namespace: __cm_namespace }) })) ?? [];
  const __cm_expr = (__cm_name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(__cm_name) ? "tools." + __cm_name : "tools[" + JSON.stringify(__cm_name) + "]";
  const __cm_items = __cm_found.slice(__cm_offset, __cm_offset + __cm_limit).map((__cm_tool) => ({ path: __cm_expr(__cm_tool.name), description: __cm_tool.description, signature: __cm_expr(__cm_tool.name) }));
  const __cm_remaining = Math.max(0, __cm_found.length - __cm_offset - __cm_items.length);
  return { items: __cm_items, remaining: __cm_remaining, next: __cm_remaining > 0 ? { offset: __cm_offset + __cm_items.length } : null };
})`;

const OBJECT_KEYS_SHIM = "ALL_TOOLS.map((__cm_tool) => __cm_tool.name)";

/** `Object.keys(tools.$codemode)` — the platform namespace only lists `search`. */
const CODEMODE_KEYS_SHIM = '["search"]';

/**
 * `Object.keys(tools.<ns>)` — Pi's `tools` is flat, so filter the live catalog
 * by the namespace's identifier prefix (both the plain and MCP `mcp__` spellings).
 */
function namespaceKeysShim(segments: readonly string[]): string {
  const prefix = toCodemodeIdentifier(segments.join("__"));
  return `ALL_TOOLS.map((__cm_tool) => __cm_tool.name).filter((__cm_name) => __cm_name.startsWith(${JSON.stringify(`${prefix}_`)}) || __cm_name.startsWith(${JSON.stringify(`mcp__${prefix}_`)}))`;
}

/** Whether `node` is the argument of an `Object.keys(...)` call — that call owns the replacement range. */
function isObjectKeysTarget(node: AstNode, parents: readonly AstNode[]): boolean {
  const parent = parents[parents.length - 1];
  if (parent?.type !== "CallExpression") return false;
  if ((parent.arguments as AstNode[] | undefined)?.[0] !== node) return false;
  const chain = collectChain(parent.callee as AstNode);
  return chain?.root === "Object" && chain.segments.join(".") === "keys";
}

function isInnerMember(node: AstNode, parents: readonly AstNode[]): boolean {
  const parent = parents[parents.length - 1];
  return parent?.type === "MemberExpression" && parent.object === node;
}

/**
 * Rewrite OpenCode-dialect constructs into Pi codemode syntax. A no-op on
 * already-Pi code. Call it before the await pass so the rewritten tool calls
 * still get their missing `await`.
 */
export function compileOpencodeDialect(code: string, options: OpencodeCompileOptions = {}): OpencodeCompileResult {
  const ast = parseScript(code);
  if (!ast) return { code, changed: false, rewrites: 0, warnings: [] };
  // A locally bound `tools` shadows the sandbox global, so every path under it
  // is the script's own object — never rewrite it or warn about it.
  if (collectBoundNames(ast).has("tools")) return { code, changed: false, rewrites: 0, warnings: [] };

  const catalog = buildCatalog(options.tools ?? []);
  const replacements: Replacement[] = [];
  const warnings: string[] = [];
  let rewrites = 0;

  walk(ast, [], (node, parents) => {
    if (node.type === "MemberExpression") {
      if (isInnerMember(node, parents)) return;
      // `Object.keys(tools.<ns>)` / `for...in tools.<ns>`: the call-level (or
      // warning-level) handling owns this range.
      if (isObjectKeysTarget(node, parents)) return;
      const parent = parents[parents.length - 1];
      if (parent?.type === "ForInStatement" && parent.right === node) {
        const chain = collectChain(node);
        if (chain?.root === "tools" && chain.segments.length > 0) {
          warnings.push(
            `\`for...in tools.${chain.segments.join(".")}\` iterates nothing in Pi (\`tools\` is flat); use \`ALL_TOOLS.map((t) => t.name)\` instead`,
          );
          return;
        }
      }
      const chain = collectChain(node);
      if (chain?.root !== "tools" || chain.segments.length === 0) return;

      if (chain.segments[0] === "$codemode") {
        if (chain.segments.length === 2 && chain.segments[1] === "search") {
          replacements.push({ start: node.start, end: node.end, text: OPENCODE_SEARCH_SHIM });
          rewrites++;
        } else {
          warnings.push(`unsupported OpenCode \`$codemode.${chain.segments.slice(1).join(".")}\`; left unchanged`);
        }
        return;
      }

      const path = chain.segments.join(".");
      const resolution = resolveToolPath(chain.segments, catalog);
      if (resolution.matched === undefined && (options.tools?.length ?? 0) > 0) {
        warnings.push(`could not resolve OpenCode tool path \`tools.${path}\` in the Pi catalog; flattened to \`tools.${resolution.identifier}\``);
      }
      const text = `tools.${resolution.identifier}`;
      if (code.slice(node.start, node.end) !== text) {
        replacements.push({ start: node.start, end: node.end, text });
        rewrites++;
      }
      return;
    }

    if (node.type === "CallExpression") {
      const chain = collectChain(node.callee as AstNode);
      if (chain?.root !== "Object" || chain.segments.join(".") !== "keys") return;
      const first = (node.arguments as AstNode[])[0];
      const target = first ? collectChain(first) : undefined;
      if (target?.root !== "tools") return;
      if (target.segments.length === 0) {
        replacements.push({ start: node.start, end: node.end, text: OBJECT_KEYS_SHIM });
        rewrites++;
        return;
      }
      if (target.segments[0] === "$codemode" && target.segments.length === 1) {
        replacements.push({ start: node.start, end: node.end, text: CODEMODE_KEYS_SHIM });
        rewrites++;
        return;
      }
      replacements.push({ start: node.start, end: node.end, text: namespaceKeysShim(target.segments) });
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