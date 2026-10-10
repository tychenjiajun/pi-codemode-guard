// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------
//
// Source snippets that several test files need verbatim. Keeping them here
// means a scope-analysis fixture is written once, so the dialect tests cannot
// drift into testing subtly different scripts.

/**
 * A script that binds its own `tools` object and calls a method on it. The
 * guard must treat it as ordinary user code: no namespace flattening, no
 * dialect detection.
 */
export const LOCAL_TOOLS_SCRIPT =
  "const tools = { orders: { lookup: (id) => ({ id }) } };\nconst r = tools.orders.lookup(1);";

/** A script that binds its own `tools` and enumerates it — the shared
 * `Object.keys(tools)` shape that OpenCode and PTC both use. */
export const LOCAL_EMPTY_TOOLS_KEYS_SCRIPT = "const tools = {};\nconst names = Object.keys(tools);";
