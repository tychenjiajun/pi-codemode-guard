// ---------------------------------------------------------------------------
// Tool catalog + AST traversal shared by the dialect compilers
// ---------------------------------------------------------------------------
//
// A dialect rewrite needs to turn a written path (OpenCode's
// `tools.orders.lookup`, Cloudflare's `github.list_pull_requests`) back into Pi's
// flat `tools.<identifier>`. That needs Pi's live catalog, so the callers pass
// the tool names from `pi.getAllTools()` as plain data and this module keeps the
// matching pure and deterministic.
//
// The same `walk` / `collectChain` helpers drive both detection and rewriting so
// the two never disagree about what a member chain is.

import { toCodemodeIdentifier } from "./identifiers.ts";
import { childNodes, type AstNode } from "./parse.ts";

export interface Chain {
  readonly root: string;
  readonly segments: string[];
}

export interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
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
}

/** The `foo.bar` / `foo["bar"]` segment of a member expression, if visible. */
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

/** Flatten a member expression into `{ root, segments }`, or `undefined`. */
export function collectChain(node: AstNode): Chain | undefined {
  if (node.type === "Identifier") return { root: node.name as string, segments: [] };
  if (node.type !== "MemberExpression") return undefined;
  const parent = collectChain(node.object as AstNode);
  if (!parent) return undefined;
  const segment = memberSegment(node);
  if (segment === undefined) return undefined;
  return { root: parent.root, segments: [...parent.segments, segment] };
}

/** Depth-first AST walk carrying the ancestor chain. */
export function walk(
  node: AstNode,
  parents: readonly AstNode[],
  visit: (node: AstNode, parents: readonly AstNode[]) => void,
): void {
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

export function buildCatalog(names: readonly string[]): Catalog {
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

/**
 * Resolve a namespace path to a Pi codemode identifier. Exact separator
 * conventions first, then a fuzzy `normalizeToolKey` match, then a
 * deterministic flatten so the path at least parses.
 */
export function resolveToolPath(segments: readonly string[], catalog: Catalog): Resolution {
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

  const key = normalizeToolKey(segments.join("."));
  const fuzzy = key === "" ? undefined : catalog.normalized.get(key);
  if (fuzzy !== undefined) return { identifier: toCodemodeIdentifier(fuzzy), matched: fuzzy };

  return { identifier: toCodemodeIdentifier(segments.join("__")) };
}