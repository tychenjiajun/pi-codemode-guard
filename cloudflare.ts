// ---------------------------------------------------------------------------
// Cloudflare agents codemode dialect -> Pi codemode dialect
// ---------------------------------------------------------------------------
//
// `@cloudflare/codemode` (in the `cloudflare/agents` repo, packages/codemode)
// exposes a different program API than Pi:
//
//   Cloudflare agents                             Pi
//   ────────────────────────────────────────────  ─────────────────────────────
//   async () => { ... }   (whole program)         the async function body
//   codemode.getWeather({ ... })                  tools.getWeather({ ... })
//   state.readFile("/path")   (provider ns)       tools.state_readFile({ ... })
//   codemode.search("query")   -> { results }     searchTools("query") -> { items }
//   codemode.describe(path)    -> { types }       describeTool(path) -> { declaration }
//   codemode.run(name) / codemode.step(...)       (no equivalent)
//
// The async-arrow wrapper is already removed by `unwrap-iife`; this pass handles
// the namespace and platform-SDK rewrites. Cloudflare sanitizes tool names with
// `sanitizeToolName` (hyphens/dots -> `_`, invalid chars stripped, digit-leading
// names prefixed with `_`, reserved words suffixed with `_`), which differs from
// Pi's `toCodemodeIdentifier`, so the live catalog is required to map back.

import { buildCatalog, collectBoundNames, collectChain, normalizeToolKey, walk, type Catalog, type Replacement, type Resolution } from "./catalog.ts";
import { toCodemodeIdentifier } from "./identifiers.ts";
import { parseScript, type AstNode } from "./parse.ts";

export interface CloudflareCompileOptions {
  /** Pi tool names, from `pi.getAllTools()`. Used to resolve provider namespaces. */
  readonly tools?: readonly string[];
}

export interface CloudflareCompileResult {
  readonly code: string;
  readonly changed: boolean;
  readonly rewrites: number;
  readonly warnings: readonly string[];
}

/** Cloudflare's reserved-word set, copied from `@cloudflare/codemode`'s utils. */
const JS_RESERVED = new Set([
  "abstract", "arguments", "await", "boolean", "break", "byte", "case", "catch", "char", "class",
  "const", "continue", "debugger", "default", "delete", "do", "double", "else", "enum", "eval",
  "export", "extends", "false", "final", "finally", "float", "for", "function", "goto", "if",
  "implements", "import", "in", "instanceof", "int", "interface", "let", "long", "native", "new",
  "null", "package", "private", "protected", "public", "return", "short", "static", "super",
  "switch", "synchronized", "this", "throw", "throws", "transient", "true", "try", "typeof",
  "undefined", "var", "void", "volatile", "while", "with", "yield",
]);

/** Globals that are never a Cloudflare provider namespace. */
const JS_GLOBALS = new Set([
  "Array", "ArrayBuffer", "Atomics", "BigInt", "Boolean", "DataView", "Date", "Error", "EvalError",
  "FinalizationRegistry", "Float32Array", "Float64Array", "Infinity", "Int16Array", "Int32Array",
  "Int8Array", "Intl", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy",
  "RangeError", "ReferenceError", "Reflect", "RegExp", "Set", "String", "Symbol", "SyntaxError",
  "TypeError", "URIError", "Uint16Array", "Uint32Array", "Uint8Array", "Uint8ClampedArray",
  "WeakMap", "WeakRef", "WeakSet", "console", "globalThis", "undefined",
]);

/** Pi codemode sandbox helpers: addresses, not provider namespaces. */
const PI_HELPERS = new Set([
  "tools", "models", "text", "image", "ALL_TOOLS", "searchTools", "describeTool", "describeNamespace", "store",
]);

/** Cloudflare's `sanitizeToolName`: a tool name -> the identifier its sandbox uses. */
export function cloudflareSanitize(name: string): string {
  if (!name) return "_";
  let sanitized = name.replace(/[-.\s]/g, "_");
  sanitized = sanitized.replace(/[^a-zA-Z0-9_$]/g, "");
  if (!sanitized) return "_";
  if (/^[0-9]/.test(sanitized)) sanitized = "_" + sanitized;
  if (JS_RESERVED.has(sanitized)) sanitized = sanitized + "_";
  return sanitized;
}

/** Best-effort inverse of `cloudflareSanitize` for when no catalog is available. */
export function cloudflareUnsanitize(identifier: string): string {
  if (identifier.endsWith("_") && JS_RESERVED.has(identifier.slice(0, -1))) {
    return identifier.slice(0, -1);
  }
  if (/^_[0-9]/.test(identifier)) return identifier.slice(1);
  return identifier;
}

/**
 * A shim for `codemode.search(query)`. Takes Cloudflare's positional query and
 * returns Cloudflare's `{ results, total, truncated }` shape, backed by Pi's
 * `searchTools`.
 */
export const CLOUDFLARE_SEARCH_SHIM = `(async (__cm_query) => {
  const __cm_found = (await searchTools(String(__cm_query ?? ""))) ?? [];
  const __cm_results = __cm_found.map((__cm_tool) => {
    const __cm_path = String(__cm_tool.name ?? "");
    const __cm_split = __cm_path.indexOf("__");
    return {
      path: __cm_path,
      connector: __cm_split === -1 ? "" : __cm_path.slice(0, __cm_split),
      method: __cm_split === -1 ? __cm_path : __cm_path.slice(__cm_split + 2),
      description: __cm_tool.description,
      kind: "method"
    };
  });
  return { results: __cm_results, total: __cm_results.length, truncated: false };
})`;

/**
 * A shim for `codemode.describe(path)`. Returns Cloudflare's
 * `{ path, description, types }` shape, backed by Pi's `describeTool`.
 */
export const CLOUDFLARE_DESCRIBE_SHIM = `(async (__cm_target) => {
  const __cm_path = String(__cm_target ?? "");
  const __cm_tool = await describeTool(__cm_path);
  return { path: __cm_path, description: __cm_tool?.description, types: __cm_tool?.declaration ?? "", kind: "method" };
})`;

interface CloudflareCatalog {
  readonly catalog: Catalog;
  /** `cloudflareSanitize(name)` -> name. */
  readonly sanitized: ReadonlyMap<string, string>;
}

function buildCloudflareCatalog(names: readonly string[]): CloudflareCatalog {
  const catalog = buildCatalog(names);
  const sanitized = new Map<string, string>();
  for (const name of names) {
    const key = cloudflareSanitize(name);
    if (!sanitized.has(key)) sanitized.set(key, name);
  }
  return { catalog, sanitized };
}

/**
 * Resolve a Cloudflare path to a Pi identifier: exact separators, then the
 * Cloudflare-sanitized spelling, then a fuzzy `normalizeToolKey` match, then a
 * deterministic flatten.
 */
function resolveCloudflarePath(segments: readonly string[], catalog: CloudflareCatalog): Resolution {
  const path = segments.join(".");
  const candidates = [
    path,
    segments.join("__"),
    segments.join("_"),
    segments.join("/"),
    segments.join("-"),
  ];
  for (const candidate of candidates) {
    const matched = catalog.catalog.identifiers.get(toCodemodeIdentifier(candidate));
    if (matched !== undefined) return { identifier: toCodemodeIdentifier(matched), matched };
  }

  const sanitizedMatch = catalog.sanitized.get(cloudflareSanitize(path));
  if (sanitizedMatch !== undefined) {
    return { identifier: toCodemodeIdentifier(sanitizedMatch), matched: sanitizedMatch };
  }

  const key = normalizeToolKey(path);
  const fuzzy = key === "" ? undefined : catalog.catalog.normalized.get(key);
  if (fuzzy !== undefined) return { identifier: toCodemodeIdentifier(fuzzy), matched: fuzzy };

  return { identifier: toCodemodeIdentifier(cloudflareUnsanitize(segments[segments.length - 1] ?? "")) };
}

/** Whether `node` is the object half of a member expression, i.e. not the final property. */
function isInnerMember(node: AstNode, parents: readonly AstNode[]): boolean {
  const parent = parents[parents.length - 1];
  return parent?.type === "MemberExpression" && parent.object === node;
}

/**
 * Rewrite Cloudflare-agents-dialect constructs into Pi codemode syntax. A no-op
 * on already-Pi code. Call it before the await pass so rewritten tool calls
 * still get their missing `await`.
 */
export function compileCloudflareDialect(
  code: string,
  options: CloudflareCompileOptions = {},
): CloudflareCompileResult {
  const ast = parseScript(code);
  if (!ast) return { code, changed: false, rewrites: 0, warnings: [] };

  const names = options.tools ?? [];
  const catalog = buildCloudflareCatalog(names);
  const bound = collectBoundNames(ast);
  const replacements: Replacement[] = [];
  const warnings: string[] = [];
  let rewrites = 0;

  const push = (node: AstNode, text: string): void => {
    if (code.slice(node.start, node.end) === text) return;
    replacements.push({ start: node.start, end: node.end, text });
    rewrites++;
  };

  walk(ast, [], (node, parents) => {
    if (node.type !== "MemberExpression") return;
    if (isInnerMember(node, parents)) return;
    const chain = collectChain(node);
    if (!chain || chain.segments.length === 0) return;
    if (bound.has(chain.root)) return;

    if (chain.root === "codemode") {
      const method = chain.segments[0]!;
      if (chain.segments.length === 1 && method === "search") {
        push(node, CLOUDFLARE_SEARCH_SHIM);
        return;
      }
      if (chain.segments.length === 1 && method === "describe") {
        push(node, CLOUDFLARE_DESCRIBE_SHIM);
        return;
      }
      if (chain.segments.length === 1 && (method === "run" || method === "step")) {
        warnings.push(`\`codemode.${method}\` has no Pi equivalent; left unchanged`);
        return;
      }
      if (chain.segments.length > 1) {
        warnings.push(`unexpected Cloudflare \`codemode.${chain.segments.join(".")}\` path; left unchanged`);
        return;
      }

      const resolution = resolveCloudflarePath([method], catalog);
      if (resolution.matched === undefined && names.length > 0) {
        warnings.push(
          `could not resolve Cloudflare tool \`codemode.${method}\` in the Pi catalog; mapped to \`tools.${resolution.identifier}\``,
        );
      }
      push(node, `tools.${resolution.identifier}`);
      return;
    }

    if (JS_GLOBALS.has(chain.root) || PI_HELPERS.has(chain.root)) return;

    // A named provider namespace, e.g. `state.readFile` or `github.list_pull_requests`.
    // The provider is the chain root, so include it in the path. Only rewrite when
    // the catalog confirms it: never flatten an arbitrary global or a local object's method.
    const path = [chain.root, ...chain.segments];
    const resolution = resolveCloudflarePath(path, catalog);
    if (resolution.matched === undefined) {
      if (names.length > 0) {
        warnings.push(
          `could not resolve Cloudflare provider \`${path.join(".")}\` in the Pi catalog; left unchanged`,
        );
      }
      return;
    }
    push(node, `tools.${resolution.identifier}`);
  });

  if (replacements.length === 0) return { code, changed: false, rewrites: 0, warnings };

  replacements.sort((a, b) => b.start - a.start);
  let result = code;
  for (const replacement of replacements) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return { code: result, changed: true, rewrites, warnings };
}