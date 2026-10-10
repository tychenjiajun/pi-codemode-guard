import { describe, expect, it } from "vitest";

import { compileCodemodeSource } from "../compile.ts";
import { parseScript } from "../core/parse.ts";
import { translateCodemode } from "./translate.ts";

describe("translateCodemode: bare tool calls", () => {
  it("translates a bare call into `tools.<identifier>`", () => {
    const result = translateCodemode('const r = await search({ query: "x" });', { tools: ["search"] });
    expect(result.code).toBe('const r = await tools.search({ query: "x" });');
    expect(result.groups.bare).toBe(1);
  });

  it("resolves a bare name through the catalog to Pi's identifier", () => {
    const result = translateCodemode("await web_search({ q: 1 });", { tools: ["web-search"] });
    expect(result.code).toBe("await tools.web_search({ q: 1 });");
  });

  it("leaves a bare call the catalog does not know", () => {
    const result = translateCodemode("await missing({ q: 1 });", { tools: ["search"] });
    expect(result.changed).toBe(false);
    expect(result.code).toBe("await missing({ q: 1 });");
  });

  it("leaves a locally declared function alone", () => {
    const code = "const search = (q) => q;\nreturn search({ q: 1 });";
    expect(translateCodemode(code, { tools: ["search"] }).changed).toBe(false);
  });

  it("never rewrites a sandbox helper, even when a tool shares its name", () => {
    const result = translateCodemode('text("hi");\nsearchTools("q");', { tools: ["text", "searchTools"] });
    expect(result.changed).toBe(false);
  });
});

describe("translateCodemode: mixed dialects in one snippet", () => {
  it("translates OpenCode, Cloudflare, TanStack and bare calls together", () => {
    const source = [
      'const a = await tools.orders.lookup({ id: "1" });',
      'const b = await codemode.search("x");',
      'const c = await external_getWeather({ location: "London" });',
      'const d = await search({ query: "y" });',
    ].join("\n");
    const result = translateCodemode(source, {
      tools: ["orders.lookup", "getWeather", "search"],
      dialect: "unknown",
    });
    expect(result.changed).toBe(true);
    expect(result.groups).toMatchObject({ opencode: 1, cloudflare: 1, tanstack: 1, bare: 1 });
    expect(result.code).toContain("tools.orders_lookup");
    expect(result.code).toContain("searchTools(String(");
    expect(result.code).toContain('tools.getWeather({ location: "London" })');
    expect(result.code).toContain('tools.search({ query: "y" })');
    expect(parseScript(result.code)).toBeDefined();
  });

  it("translates a catalog-confirmed namespace path even outside the OpenCode dialect", () => {
    const result = translateCodemode("const o = await tools.orders.lookup({ id: 1 });", {
      tools: ["orders.lookup"],
      dialect: "pi",
    });
    expect(result.code).toBe("const o = await tools.orders_lookup({ id: 1 });");
    expect(result.groups.opencode).toBe(1);
  });

  it("does not flatten a function property when the path is not a catalog tool", () => {
    const result = translateCodemode("const n = tools.read.length;", { tools: ["read"], dialect: "pi" });
    expect(result.changed).toBe(false);
  });

  it("is idempotent", () => {
    const source = [
      'const a = await tools.orders.lookup({ id: "1" });',
      'const c = await external_getWeather({ location: "London" });',
      'const d = await search({ query: "y" });',
    ].join("\n");
    const options = { tools: ["orders.lookup", "getWeather", "search"], dialect: "unknown" };
    const once = translateCodemode(source, options);
    const twice = translateCodemode(once.code, options);
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });
});

describe("translateCodemode: Object.keys disambiguation", () => {
  it("uses the OpenCode spelling by default", () => {
    const result = translateCodemode("const n = Object.keys(tools);", { tools: [] });
    expect(result.code).toBe("const n = ALL_TOOLS.map((__cm_tool) => __cm_tool.name);");
  });

  it("uses the PTC spelling for the PTC dialect", () => {
    const result = translateCodemode("const n = Object.keys(tools);", { tools: [], dialect: "ptc" });
    expect(result.code).toBe("const n = ALL_TOOLS.map((__ptc_tool) => __ptc_tool.name);");
  });

  it("warns about Object.keys(tools.<ns>) in the PTC dialect instead of rewriting", () => {
    const result = translateCodemode("const n = Object.keys(tools.orders);", {
      tools: ["orders.lookup"],
      dialect: "ptc",
    });
    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Object.keys(tools.orders)");
  });
});

describe("compileCodemodeSource: statement-based translation", () => {
  it("repairs every construct regardless of the snippet's dialect", () => {
    const source = [
      "// @options: {\"max_output_tokens\": 2000}",
      'const a = tools.orders.lookup({ id: "1" });',
      'const b = codemode.search("x");',
      'text(a, b);',
    ].join("\n");
    const result = compileCodemodeSource(source, { tools: ["orders.lookup"] });
    expect(result.dialect).toBe("opencode");
    expect(result.passes).toContain("opencode-dialect(1)");
    expect(result.passes).toContain("cloudflare-dialect(1)");
    expect(result.code).toContain("await tools.orders_lookup(");
    expect(result.code).toContain("await (async (__cm_query)");
  });

  it("translates and awaits a bare tool call", () => {
    const result = compileCodemodeSource('const r = search({ query: "x" });\ntext(r);', { tools: ["search"] });
    expect(result.passes).toContain("bare-tool-calls(1)");
    expect(result.code).toContain('const r = await tools.search({ query: "x" });');
  });
});
