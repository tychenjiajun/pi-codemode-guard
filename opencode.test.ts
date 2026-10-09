import { describe, expect, it } from "vitest";

import { compileOpencodeDialect, detectCodemodeDialect, normalizeToolKey } from "./opencode.ts";

describe("detectCodemodeDialect", () => {
  it("detects the OpenCode search namespace", () => {
    const detection = detectCodemodeDialect('const r = await tools.$codemode.search({ query: "order" });');
    expect(detection.dialect).toBe("opencode");
    expect(detection.signals).toContain("$codemode.search");
  });

  it("detects OpenCode namespace tool paths", () => {
    const detection = detectCodemodeDialect('const o = await tools.orders.lookup({ id: "1" });');
    expect(detection.dialect).toBe("opencode");
    expect(detection.signals).toContain("tools.<namespace>.<tool>");
  });

  it("detects Object.keys(tools)", () => {
    expect(detectCodemodeDialect("const names = Object.keys(tools);").dialect).toBe("opencode");
  });

  it("detects the Pi helpers", () => {
    expect(detectCodemodeDialect('const hits = await searchTools("x");').dialect).toBe("pi");
    expect(detectCodemodeDialect("return ALL_TOOLS.map((t) => t.name);").dialect).toBe("pi");
    expect(detectCodemodeDialect('// @options: {"timeout_ms": 1000}\nreturn 1;').dialect).toBe("pi");
  });

  it("does not mistake a plain tool call or result access for OpenCode", () => {
    expect(detectCodemodeDialect('const r = await tools.bash({ command: "ls" });').dialect).toBe("unknown");
    expect(detectCodemodeDialect('const r = tools.bash({ command: "ls" }).output;').dialect).toBe("unknown");
  });
});

describe("normalizeToolKey", () => {
  it("collapses separators for fuzzy matching", () => {
    expect(normalizeToolKey("mcp__dev-radius__search")).toBe("mcp_dev_radius_search");
    expect(normalizeToolKey("mcp.dev.radius.search")).toBe("mcp_dev_radius_search");
  });
});

describe("compileOpencodeDialect", () => {
  it("rewrites an exact namespace path to a Pi identifier", () => {
    const result = compileOpencodeDialect('await tools.orders.lookup({ id: "1" });', {
      tools: ["orders.lookup"],
    });
    expect(result.changed).toBe(true);
    expect(result.code).toBe('await tools.orders_lookup({ id: "1" });');
  });

  it("fuzzy-matches a nested path against a flattened MCP name", () => {
    const result = compileOpencodeDialect('await tools.mcp.dev.radius.search({ query: "x" });', {
      tools: ["mcp__dev-radius__search"],
    });
    expect(result.code).toBe('await tools.mcp__dev_radius__search({ query: "x" });');
  });

  it("rewrites bracket segments", () => {
    const result = compileOpencodeDialect('await tools.context7["resolve-library-id"]({ name: "react" });', {
      tools: ["context7.resolve-library-id"],
    });
    expect(result.code).toBe('await tools.context7_resolve_library_id({ name: "react" });');
  });

  it("compiles tools.$codemode.search to a searchTools shim", () => {
    const result = compileOpencodeDialect('const page = await tools.$codemode.search({ query: "order status" });', {
      tools: [],
    });
    expect(result.changed).toBe(true);
    expect(result.code).toContain("searchTools(__cm_query");
    expect(result.code).toContain("items: __cm_items");
    expect(result.code).toContain("next:");
    expect(result.code.startsWith("const page = await (async (__cm_req)")).toBe(true);
  });

  it("rewrites Object.keys(tools)", () => {
    const result = compileOpencodeDialect("const namespaces = Object.keys(tools);", { tools: [] });
    expect(result.code).toBe("const namespaces = ALL_TOOLS.map((__cm_tool) => __cm_tool.name);");
  });

  it("leaves a valid single-level tool call alone", () => {
    const result = compileOpencodeDialect('await tools.bash({ command: "ls" });', { tools: ["bash"] });
    expect(result.changed).toBe(false);
  });

  it("flattens an unresolvable path and warns when a catalog is present", () => {
    const result = compileOpencodeDialect("await tools.unknown.nested();", { tools: ["bash"] });
    expect(result.changed).toBe(true);
    expect(result.code).toContain("tools.unknown__nested");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("returns unchanged for unparseable source", () => {
    const result = compileOpencodeDialect("const = ;", { tools: [] });
    expect(result.changed).toBe(false);
  });
});
