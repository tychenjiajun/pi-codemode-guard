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

import { toCodemodeIdentifier } from "./identifiers.ts";
import { childNodes, parseScript, type AstNode } from "./parse.ts";

export type CodemodeDialect = "pi" | "opencode" | "unknown";

export interface DialectDetection {
  readonly dialect: CodemodeDialect;
  /** Why the dialect was chosen, e.g. `$codemode.search`, `tools.a.b`, `searchTools`. */
  readonly signals: readonly string[];
}

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

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface Chain {
  readonly root: string;
  readonly segments: string[];
}

/** A runtime shim for `tools.$codemode.search(...)`, matching OpenCode's result shape. */
export const OPENCODE_SEARCH_SHIM = `(async (__cm_req) => {
  const __cm_query = __cm_req?.query ?? "";
  const __cm_namespace = __cm_req?.namespace;
  const __cm_offset = __cm_req?.offset ?? 0;
  const __cm_limit = __cm_req?.limit ?? 10;
  const __cm_found = (await searchTools(__cm_query, { limit: __cm_offset + __cm_limit, ...(__cm_namespace === undefined ? {} : { namespace: __cm_namespace }) })) ?? [];
  const __cm_expr = (__cm_name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(__cm_name) ? "tools." + __cm_name : "tools[" + JSON.stringify(__cm_name) + "]";
  const __cm_items = __cm_found.slice(__cm_offset, __cm_offset + __cm_limit).map((__cm_tool) => ({ path: __cm_expr(__cm_tool.name), description: __cm_tool.description, signature: __cm_expr(__cm_tool.name) }));
  const __cm_remaining = Math.max(0, __cm_found.length - __cm_offset - __cm_items.length);
  return { items: __cm_items, remaining: __cm_remaining, next: __cm_remaining > 0 ? { offset: __cm_offset + __cm_items.length } : null };
})`;

const OBJECT_KEYS_SHIM = "ALL_TOOLS.map((__cm_tool) => __cm_tool.name)";

/** `Object.keys(tools)` and the other OpenCode tree idioms. */
function memberSegment(node: AstNode): string | undefined {
  if (node.computed !== true && (node.property as AstNode).type === "Identifier") {
    return (node.property as AstNode).name as string;
  }
  if (
    node.computed === true &&
    (node.property as AstNode).type === "Literal" &&
    typeof (node.property as AstNode).value === "string"
  ) {
    return (node.property as AstNode).value as string;
  }
  return undefined;
}

function collectChain(node: AstNode): Chain | undefined {
  if (node.type === "Identifier") return { root: node.name as string, segments: [] };
  if (node.type !== "MemberExpression") return undefined;
  const parent = collectChain(node.object as AstNode);
  if (!parent) return undefined;
  const segment = memberSegment(node);
  if (segment === undefined) return undefined;
  return { root: parent.root, segments: [...parent.segments, segment] };
}

function walk(node: AstNode, parents: readonly AstNode[], visit: (node: AstNode, parents: readonly AstNode[]) => void): void {
  visit(node, parents);
  const nextParents = [...parents, node];
  for (const child of childNodes(node)) walk(child, nextParents, visit);
}

/** Lowercase + collapse everything that is not `[a-z0-9]` into `_`, for fuzzy name matching. */
export function normalizeToolKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

interface Catalog {
  /** `toCodemodeIdentifier(name)` -> name. */
  readonly identifiers: ReadonlyMap<string, string>;
  /** `normalizeToolKey(name)` -> name, with ambiguous keys removed. */
  readonly normalized: ReadonlyMap<string, string>;
}

function buildCatalog(names: readonly string[]): Catalog {
  const identifiers = new Map<string, string>();
  const normalized = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const name of names) {
    identifiers.set(toCodemodeIdentifier(name), name);
    const key = normalizeToolKey(name);
    if (key === "") continue;
    const existing = normalized.get(key);
    if (existing !== undefined && existing !== name) ambiguous.add(key);
    else normalized.set(key, name);
  }
  for (const key of ambiguous) normalized.delete(key);
  return { identifiers, normalized };
}

interface Resolution {
  readonly identifier: string;
  readonly matched?: string;
}

function resolveToolPath(segments: readonly string[], catalog: Catalog): Resolution {
  // Exact candidates for the common separator conventions.
  const candidates = [
    segments.join("."),
    segments.join("__"),
    segments.join("_"),
    segments.join("/"),
    segments.join("-"),
  ];
  for (const candidate of candidates) {
    const identifier = toCodemodeIdentifier(candidate);
    const matched = catalog.identifiers.get(identifier);
    if (matched !== undefined) return { identifier, matched };
  }

  // Fuzzy match: `mcp.dev.radius.search` vs `mcp__dev-radius__search`.
  const key = normalizeToolKey(segments.join("."));
  const fuzzy = key === "" ? undefined : catalog.normalized.get(key);
  if (fuzzy !== undefined) return { identifier: toCodemodeIdentifier(fuzzy), matched: fuzzy };

  // No catalog entry: flatten deterministically so the path at least parses.
  return { identifier: toCodemodeIdentifier(segments.join("__")) };
}

/** Lexical + AST signals that identify the dialect of a script. */
export function detectCodemodeDialect(code: string): DialectDetection {
  const signals = new Set<string>();

  if (code.includes("$codemode")) signals.add("$codemode");
  if (/@options/i.test(code)) signals.add("pi:@options");

  const ast = parseScript(code);
  if (ast) {
    walk(ast, [], (node, parents) => {
      if (node.type === "MemberExpression") {
        const parent = parents[parents.length - 1];
        if (parent?.type === "MemberExpression" && parent.object === node) return;
        const chain = collectChain(node);
        if (chain?.root === "tools") {
          if (chain.segments[0] === "$codemode") signals.add("$codemode.search");
          else if (chain.segments.length >= 2) signals.add("tools.<namespace>.<tool>");
        }
        if (chain?.root === "models" && chain.segments.length >= 1) signals.add("pi:models");
        return;
      }

      if (node.type === "Identifier") {
        const name = node.name as string;
        if (name === "ALL_TOOLS") signals.add("pi:ALL_TOOLS");
        if (name === "searchTools" || name === "describeTool" || name === "describeNamespace") {
          signals.add(`pi:${name}`);
        }
        return;
      }

      if (node.type === "CallExpression") {
        const chain = collectChain(node.callee as AstNode);
        if (chain?.root === "Object" && chain.segments.join(".") === "keys") {
          const first = (node.arguments as AstNode[])[0];
          const target = first ? collectChain(first) : undefined;
          if (target?.root === "tools") {
            signals.add(target.segments.length === 0 ? "Object.keys(tools)" : "Object.keys(tools.<ns>)");
          }
        }
        if (chain?.root === "tools" && chain.segments[0] === "$codemode") signals.add("$codemode.search");
      }
    });
  }

  const list = [...signals];
  const opencode = list.some((signal) => signal.startsWith("$codemode") || signal === "tools.<namespace>.<tool>" || signal.startsWith("Object.keys(tools"));
  if (opencode) return { dialect: "opencode", signals: list };
  const pi = list.some((signal) => signal.startsWith("pi:"));
  if (pi) return { dialect: "pi", signals: list };
  return { dialect: "unknown", signals: list };
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

  const catalog = buildCatalog(options.tools ?? []);
  const replacements: Replacement[] = [];
  const warnings: string[] = [];
  let rewrites = 0;

  walk(ast, [], (node, parents) => {
    if (node.type === "MemberExpression") {
      if (isInnerMember(node, parents)) return;
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
      if (target.segments.length > 0) {
        warnings.push(`\`Object.keys(tools.${target.segments.join(".")})\` has no Pi equivalent; left unchanged`);
        return;
      }
      replacements.push({ start: node.start, end: node.end, text: OBJECT_KEYS_SHIM });
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
