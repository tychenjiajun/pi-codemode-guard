import { describe, expect, it } from "vitest";

import { compileVercelDialect } from "./translate.ts";

describe("compileVercelDialect", () => {
  it("maps a bracket access to Pi's identifier", () => {
    const result = compileVercelDialect('const r = await tools["web-search"]({ q: "pi" });', {
      tools: ["web-search"],
    });
    expect(result.changed).toBe(true);
    expect(result.rewrites).toBe(1);
    expect(result.code).toBe('const r = await tools.web_search({ q: "pi" });');
    expect(result.warnings).toEqual([]);
  });

  it("maps a hyphenated raw name through the catalog", () => {
    const result = compileVercelDialect('await tools["lookup-user"]({ id: 1 });', { tools: ["lookup-user"] });
    expect(result.code).toBe("await tools.lookup_user({ id: 1 });");
    expect(result.warnings).toEqual([]);
  });

  it("preserves optional chaining when rewriting", () => {
    const result = compileVercelDialect('const b = tools?.["other-tool"];', { tools: ["other-tool"] });
    expect(result.changed).toBe(true);
    expect(result.code).toBe("const b = tools?.other_tool;");
  });

  it("leaves a locally bound tools object alone", () => {
    const code = 'const tools = { "my-key": 1 };\nlog(tools["my-key"]);';
    const result = compileVercelDialect(code, { tools: ["my-key"] });
    expect(result.changed).toBe(false);
  });

  it("resolves a dotted raw name fuzzily to Pi's identifier rule", () => {
    const result = compileVercelDialect('await tools["mcp.dev.radius.search"]({ query: "x" });', {
      tools: ["mcp__dev-radius__search"],
    });
    expect(result.changed).toBe(true);
    expect(result.code).toBe("await tools.mcp__dev_radius__search({ query: \"x\" });");
    expect(result.warnings).toEqual([]);
  });

  it("warns about an unresolved raw name when a catalog is present", () => {
    const result = compileVercelDialect('await tools["missing-tool"]({});', { tools: ["bash"] });
    expect(result.changed).toBe(true);
    expect(result.code).toBe("await tools.missing_tool({});");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("warns once per unresolved identifier, not per occurrence", () => {
    const result = compileVercelDialect('tools["nope"]({});\ntools["nope"]({});', { tools: ["bash"] });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("nope");
  });

  it("maps a raw name without a catalog and does not warn", () => {
    const result = compileVercelDialect('await tools["lookup-user"]({});');
    expect(result.changed).toBe(true);
    expect(result.code).toBe("await tools.lookup_user({});");
    expect(result.warnings).toEqual([]);
  });

  it("leaves dot access alone", () => {
    const result = compileVercelDialect('await tools.getWeather({ location: "London" });', {
      tools: ["getWeather"],
    });
    expect(result.changed).toBe(false);
    expect(result.rewrites).toBe(0);
    expect(result.code).toBe('await tools.getWeather({ location: "London" });');
  });

  it("returns unchanged for unparseable source", () => {
    expect(compileVercelDialect("const = ;", { tools: [] }).changed).toBe(false);
  });

  it("is idempotent", () => {
    const once = compileVercelDialect('await tools["web-search"]({ q: "pi" });', { tools: ["web-search"] });
    const twice = compileVercelDialect(once.code, { tools: ["web-search"] });
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });
});
