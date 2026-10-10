// ---------------------------------------------------------------------------
// Cloudflare tool names and path resolution
// ---------------------------------------------------------------------------
//
// `@cloudflare/codemode` sanitizes a tool name differently from Pi: it prefixes
// a digit-leading name with `_` and suffixes a reserved word with `_`. Its
// sandbox addresses tools as `codemode.<name>` and as named provider namespaces
// (`state.readFile`, `github.list_pull_requests`), so a rewrite has to resolve
// those paths through both the Pi catalog and Cloudflare's spelling.
//
// This is the Cloudflare counterpart of `catalog.ts`; it shares the resolver so
// the two dialects cannot disagree about matching order.

import { buildCatalog, resolveToolPath, type Catalog, type Resolution } from "./catalog.ts";
import { toCodemodeIdentifier } from "./identifiers.ts";

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

export interface CloudflareCatalog {
  readonly catalog: Catalog;
  /** `cloudflareSanitize(name)` -> name. */
  readonly sanitized: ReadonlyMap<string, string>;
}

export function buildCloudflareCatalog(names: readonly string[]): CloudflareCatalog {
  const catalog = buildCatalog(names);
  const sanitized = new Map<string, string>();
  for (const name of names) {
    const key = cloudflareSanitize(name);
    if (!sanitized.has(key)) sanitized.set(key, name);
  }
  return { catalog, sanitized };
}

/**
 * Resolve a Cloudflare path to a Pi identifier: the shared catalog resolution,
 * with Cloudflare's sanitized spelling as an extra candidate and its
 * unsanitized last segment as the fallback.
 */
export function resolveCloudflarePath(segments: readonly string[], catalog: CloudflareCatalog): Resolution {
  return resolveToolPath(segments, catalog.catalog, {
    alternateIdentifier: (path) => catalog.sanitized.get(cloudflareSanitize(path)),
    fallbackIdentifier: (parts) => toCodemodeIdentifier(cloudflareUnsanitize(parts[parts.length - 1] ?? "")),
  });
}
