import { describe, expect, it } from "vitest";

import { compileCodemodeSource } from "../compile.ts";
import { compileOpencodeDialect } from "./translate.ts";
import { normalizeToolKey } from "../core/catalog.ts";
import { OPENCODE_SEARCH_SHIM } from "../core/shims.ts";
import { LOCAL_TOOLS_SCRIPT } from "../test-support.ts";

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

  it("leaves a locally bound tools object alone", () => {
    const code = LOCAL_TOOLS_SCRIPT;
    const result = compileOpencodeDialect(code, { tools: ["orders.lookup"] });
    expect(result.changed).toBe(false);
    expect(result.code).toBe(code);
    expect(result.warnings).toEqual([]);
  });

  it("does not reroute a shadowed tools path in the full pipeline", () => {
    const code = LOCAL_TOOLS_SCRIPT;
    const result = compileCodemodeSource(code, { tools: ["orders.lookup"] });
    expect(result.code).not.toContain("orders_lookup");
    expect(result.code).toContain("tools.orders.lookup(1)");
  });

  it("resolves a server.local path against an mcp__ catalog name", () => {
    const result = compileOpencodeDialect("await tools.github.list_issues({ repo: 'x' });", {
      tools: ["mcp__github__list_issues"],
    });
    expect(result.code).toBe("await tools.mcp__github__list_issues({ repo: 'x' });");
    expect(result.warnings).toEqual([]);
  });

  it("rewrites Object.keys(tools.<ns>) to a Pi prefix filter and executes", async () => {
    const result = compileOpencodeDialect("const names = Object.keys(tools.orders);", {
      tools: ["orders.lookup", "orders.create", "bash"],
    });
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.code).toContain('startsWith("orders_")');
    const ALL_TOOLS = [{ name: "orders_lookup" }, { name: "orders_create" }, { name: "bash" }];
    const run = new Function("ALL_TOOLS", `return ${result.code.replace("const names = ", "")};`);
    expect(run(ALL_TOOLS)).toEqual(["orders_lookup", "orders_create"]);
  });

  it("rewrites Object.keys(tools.$codemode) to [\"search\"] without double-warning", () => {
    const result = compileOpencodeDialect("const keys = Object.keys(tools.$codemode);", { tools: ["bash"] });
    expect(result.changed).toBe(true);
    expect(result.code).toBe('const keys = ["search"];');
    expect(result.warnings).toEqual([]);
  });

  it("warns that for...in over a namespace iterates nothing in Pi", () => {
    const result = compileOpencodeDialect("for (const k in tools.orders) { log(k); }", {
      tools: ["orders.lookup"],
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("for...in");
    expect(result.code).toContain("tools.orders");
  });

  it("is idempotent across shims, mcp paths, and Object.keys rewrites", () => {
    const source = [
      "const page = await tools.$codemode.search({ query: \"x\" });",
      "const keys = Object.keys(tools.orders);",
      "await tools.github.list_issues({});",
    ].join("\n");
    const once = compileOpencodeDialect(source, { tools: ["orders.lookup", "mcp__github__list_issues"] });
    expect(once.changed).toBe(true);
    const twice = compileOpencodeDialect(once.code, { tools: ["orders.lookup", "mcp__github__list_issues"] });
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });

  it("fetches one extra result so the search shim's pagination is live", async () => {
    const all = Array.from({ length: 25 }, (_, i) => ({ name: `tool_${i}`, description: `d${i}` }));
    const requests: Array<{ limit?: number }> = [];
    const searchTools = async (_query: string, options: { limit: number }) => {
      requests.push(options);
      return all.slice(0, options.limit);
    };
    const run = async (source: string) => {
      const code = compileOpencodeDialect(source, { tools: [] }).code;
      const execute = new Function("searchTools", `return (async () => { ${code} return page; })();`);
      return (await execute(searchTools)) as {
        items: unknown[];
        remaining: number;
        next: { offset: number } | null;
      };
    };
    const page1 = await run('const page = await tools.$codemode.search({ query: "x", limit: 10 });');
    expect(requests[0]?.limit).toBe(11);
    expect(page1.items).toHaveLength(10);
    expect(page1.remaining).toBe(1);
    expect(page1.next).toEqual({ offset: 10 });
    const page2 = await run('const page = await tools.$codemode.search({ query: "x", limit: 10, offset: 10 });');
    expect(page2.items).toHaveLength(10);
    expect(page2.remaining).toBe(1);
    expect(page2.next).toEqual({ offset: 20 });
    const page3 = await run('const page = await tools.$codemode.search({ query: "x", limit: 10, offset: 20 });');
    expect(page3.items).toHaveLength(5);
    expect(page3.remaining).toBe(0);
    expect(page3.next).toBeNull();
  });

  it("executes the bare search shim export directly", async () => {
    const all = Array.from({ length: 12 }, (_, i) => ({ name: `tool_${i}` }));
    const execute = new Function("searchTools", `return ${OPENCODE_SEARCH_SHIM};`);
    const shim = execute(async (_query: string, options: { limit: number }) => all.slice(0, options.limit));
    const page = (await shim({ query: "q", limit: 10 })) as { items: unknown[]; remaining: number; next: unknown };
    expect(page.items).toHaveLength(10);
    expect(page.remaining).toBe(1);
    expect(page.next).toEqual({ offset: 10 });
  });
});
