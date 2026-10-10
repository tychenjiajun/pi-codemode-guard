// ---------------------------------------------------------------------------
// Tool catalog + tool-path resolution
// ---------------------------------------------------------------------------
//
// A dialect rewrite needs to turn a written path (OpenCode's
// `tools.orders.lookup`, Cloudflare's `github.list_pull_requests`) back into Pi's
// flat `tools.<identifier>`. That needs Pi's live catalog, so the callers pass
// the tool names from `pi.getAllTools()` as plain data and this module keeps the
// matching pure and deterministic.

import { toCodemodeIdentifier } from "./identifiers.ts";
import { memberPropertyName, type AstNode } from "./parse.ts";

export interface Chain {
  readonly root: string;
  readonly segments: string[];
}

export interface Resolution {
  readonly identifier: string;
  readonly matched?: string;
}

export interface Catalog {
  /** `toCodemodeIdentifier(name)` -> name. */
  readonly identifiers: ReadonlyMap<string, string>;
  /** `normalizeToolKey(name)` -> name, with ambiguous keys removed. */
  readonly normalized: ReadonlyMap<string, string>;
  /** Exact raw tool name -> name. Wins over `identifiers` so two catalog names
   * that collide on one identifier (`web-search` / `web_search`) resolve
   * deterministically instead of order-dependently. */
  readonly exact: ReadonlyMap<string, string>;
}

/** Flatten a member expression into `{ root, segments }`, or `undefined`. */
export function collectChain(node: AstNode): Chain | undefined {
  if (node.type === "Identifier") return { root: node.name as string, segments: [] };
  if (node.type !== "MemberExpression") return undefined;
  const parent = collectChain(node.object as AstNode);
  if (!parent) return undefined;
  const segment = memberPropertyName(node);
  if (segment === undefined) return undefined;
  return { root: parent.root, segments: [...parent.segments, segment] };
}

/** Lowercase + collapse everything that is not `[a-z0-9]` into `_`, for fuzzy name matching. */
export function normalizeToolKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function buildCatalog(names: readonly string[]): Catalog {
  const identifiers = new Map<string, string>();
  const normalized = new Map<string, string>();
  const exact = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const name of names) {
    identifiers.set(toCodemodeIdentifier(name), name);
    exact.set(name, name);
    const key = normalizeToolKey(name);
    if (key === "") continue;
    const existing = normalized.get(key);
    if (existing !== undefined && existing !== name) ambiguous.add(key);
    else normalized.set(key, name);
  }
  for (const key of ambiguous) normalized.delete(key);
  return { identifiers, normalized, exact };
}

export interface ToolPathResolveOptions {
  /**
   * Alternate identifier lookup tried after the separator candidates and before
   * the fuzzy match — Cloudflare's `sanitizeToolName` spelling, for instance.
   */
  readonly alternateIdentifier?: (path: string) => string | undefined;
  /** Identifier to fall back to when nothing in the catalog matches. */
  readonly fallbackIdentifier?: (segments: readonly string[]) => string;
}

/**
 * Resolve a namespace path to a Pi codemode identifier. Exact raw-name and
 * separator-convention candidates first (including MCP's canonical `mcp__`
 * server.local spelling), then an optional dialect-specific spelling, then a
 * fuzzy `normalizeToolKey` match with and without the `mcp_` prefix, then a
 * deterministic flatten so the path at least parses.
 */
export function resolveToolPath(
  segments: readonly string[],
  catalog: Catalog,
  options: ToolPathResolveOptions = {},
): Resolution {
  const joins = [
    segments.join("."),
    segments.join("__"),
    segments.join("_"),
    segments.join("/"),
    segments.join("-"),
  ];
  const candidates = [...joins, ...joins.map((join) => `mcp__${join}`)];

  // Exact raw-name match first: an identifier collision (`web-search` vs
  // `web_search`) must resolve to the name that was actually written.
  for (const candidate of candidates) {
    const exact = catalog.exact.get(candidate);
    if (exact !== undefined) return { identifier: toCodemodeIdentifier(exact), matched: exact };
  }
  for (const candidate of candidates) {
    const identifier = toCodemodeIdentifier(candidate);
    const matched = catalog.identifiers.get(identifier);
    if (matched !== undefined) return { identifier, matched };
  }

  const alternate = options.alternateIdentifier?.(segments.join("."));
  if (alternate !== undefined) return { identifier: toCodemodeIdentifier(alternate), matched: alternate };

  const key = normalizeToolKey(segments.join("."));
  if (key !== "") {
    const fuzzy = catalog.normalized.get(key) ?? catalog.normalized.get(`mcp_${key}`);
    if (fuzzy !== undefined) return { identifier: toCodemodeIdentifier(fuzzy), matched: fuzzy };
  }

  const fallback = options.fallbackIdentifier?.(segments);
  return { identifier: fallback ?? toCodemodeIdentifier(segments.join("__")) };
}
