// ---------------------------------------------------------------------------
// Cross-dialect runtime shims
// ---------------------------------------------------------------------------
//
// Each code mode dialect has its own tool-discovery API. Pi exposes
// `searchTools` / `describeTool` / `describeNamespace` / `ALL_TOOLS`, so a
// dialect call is translated into a small inline async shim that keeps the
// dialect's result shape. The shims are pure source text: the translator splices
// them in verbatim, and they must stay valid plain JavaScript (Pi runs QuickJS,
// not TypeScript).

import { toCodemodeIdentifier } from "./identifiers.ts";

/** A runtime shim for `tools.$codemode.search(...)`, matching OpenCode's result shape. */
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

/** `Object.keys(tools.$codemode)` — the platform namespace only lists `search`. */
export const CODEMODE_KEYS_SHIM = '["search"]';

/** `Object.keys(tools.<ns>)` — Pi's `tools` is flat, so filter the live catalog
 * by the namespace's identifier prefix (both the plain and MCP `mcp__` spellings). */
export function namespaceKeysShim(segments: readonly string[]): string {
  const prefix = toCodemodeIdentifier(segments.join("__"));
  return `ALL_TOOLS.map((__cm_tool) => __cm_tool.name).filter((__cm_name) => __cm_name.startsWith(${JSON.stringify(`${prefix}_`)}) || __cm_name.startsWith(${JSON.stringify(`mcp__${prefix}_`)}))`;
}

/** A shim for `codemode.search(query)`, matching Cloudflare's result shape. */
export const CLOUDFLARE_SEARCH_SHIM = `(async (__cm_query) => {
  const __cm_found = (await searchTools(String(__cm_query ?? ""), { limit: 50 })) ?? [];
  const __cm_truncated = __cm_found.length >= 50;
  const __cm_results = __cm_found.map((__cm_tool, __cm_i) => {
    const __cm_path = String(__cm_tool.name ?? "");
    const __cm_split = __cm_path.lastIndexOf("__");
    return {
      path: __cm_path,
      connector: __cm_split > 0 ? __cm_path.slice(0, __cm_split) : __cm_path,
      method: __cm_split > 0 ? __cm_path.slice(__cm_split + 2) : __cm_path,
      description: __cm_tool.description,
      score: __cm_i,
      kind: "method"
    };
  });
  return { results: __cm_results, total: __cm_results.length, truncated: __cm_truncated };
})`;

/** A shim for `codemode.describe(path)`, matching Cloudflare's result shape. */
export const CLOUDFLARE_DESCRIBE_SHIM = `(async (__cm_target) => {
  const __cm_path = String(__cm_target ?? "");
  let __cm_sample;
  try {
    __cm_sample = await describeTool(__cm_path);
  } catch {
    __cm_sample = undefined;
  }
  if (typeof __cm_sample === "string") {
    const __cm_nl = __cm_sample.indexOf("\\n");
    const __cm_head = __cm_nl === -1 ? __cm_sample : __cm_sample.slice(0, __cm_nl);
    const __cm_description = __cm_head.startsWith("\`\`\`") || __cm_head.startsWith("{") ? "" : __cm_head;
    return { path: __cm_path, description: __cm_description, types: __cm_sample, kind: "method" };
  }
  if (__cm_sample && typeof __cm_sample === "object") {
    return {
      path: __cm_path,
      description: __cm_sample.description ?? "",
      types: __cm_sample.declaration ?? __cm_sample.types ?? "",
      kind: "method"
    };
  }
  let __cm_namespace;
  try {
    __cm_namespace = await describeNamespace(__cm_path);
  } catch {
    __cm_namespace = undefined;
  }
  if (__cm_namespace && typeof __cm_namespace === "object") {
    const __cm_tools = Array.isArray(__cm_namespace.tools) ? __cm_namespace.tools : [];
    const __cm_types = __cm_tools
      .map((__cm_t) => (typeof __cm_t === "string" ? __cm_t : String(__cm_t?.name ?? "")))
      .filter(Boolean)
      .join("\\n");
    return {
      path: __cm_path,
      description: __cm_namespace.description ?? __cm_path,
      types: __cm_types,
      kind: "connector"
    };
  }
  return { path: __cm_path, description: __cm_path + " not found.", types: "", kind: "method" };
})`;
