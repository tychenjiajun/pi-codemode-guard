import { describe, expect, it } from "vitest";

import { compileCodemodeSource } from "./compile.ts";
import { detectCodemodeDialect } from "./dialect.ts";
import { compilePtcDialect } from "./ptc.ts";

describe("detectCodemodeDialect: ptc", () => {
  it("detects parseable JavaScript using ToolCallError", () => {
    const detection = detectCodemodeDialect(
      "try { await tools.foo({}); } catch (e) { if (e instanceof ToolCallError) {} }",
    );
    expect(detection.dialect).toBe("ptc");
    expect(detection.signals).toContain("ptc:ToolCallError");
  });

  it("detects TypeScript using await import()", () => {
    const detection = detectCodemodeDialect('const fs: unknown = await import("node:fs");');
    expect(detection.dialect).toBe("ptc");
    expect(detection.signals).toContain("ptc:import()");
  });

  it("detects TypeScript using Object.keys(tools)", () => {
    const detection = detectCodemodeDialect("const names: string[] = Object.keys(tools);");
    expect(detection.dialect).toBe("ptc");
    expect(detection.signals).toContain("ptc:Object.keys(tools)");
  });

  it("detects parseable JavaScript using await import()", () => {
    const detection = detectCodemodeDialect('const fs = await import("node:fs");');
    expect(detection.dialect).toBe("ptc");
    expect(detection.signals).toContain("ptc:import()");
  });

  it("keeps parseable Object.keys(tools) as OpenCode", () => {
    const detection = detectCodemodeDialect("const names = Object.keys(tools);");
    expect(detection.dialect).toBe("opencode");
  });

  it("prefers PTC's ToolCallError over the generic Object.keys(tools) OpenCode shape", () => {
    const detection = detectCodemodeDialect(
      'const n = Object.keys(tools);\ntry { await tools["x"]({}); } catch (e) { if (e instanceof ToolCallError) {} }',
    );
    expect(detection.dialect).toBe("ptc");
    expect(detection.signals).toContain("ptc:ToolCallError");
    expect(detection.signals).toContain("Object.keys(tools)");
  });

  it("keeps OpenCode's structural $codemode signal over PTC's ToolCallError", () => {
    const detection = detectCodemodeDialect(
      'const items = await tools.$codemode.search("x");\ntry {} catch (e) { if (e instanceof ToolCallError) {} }',
    );
    expect(detection.dialect).toBe("opencode");
  });

  it("surfaces the ToolCallError warning when compile sees Object.keys(tools) too", () => {
    const result = compileCodemodeSource(
      'const n = Object.keys(tools);\ntry { await tools["x"]({}); } catch (e) { if (e instanceof ToolCallError) {} }',
      { tools: ["x"] },
    );
    expect(result.dialect).toBe("ptc");
    expect(result.warnings.some((warning) => warning.includes("ToolCallError"))).toBe(true);
  });

  it("keeps TypeScript with only a tools.<name> call as Vercel", () => {
    const detection = detectCodemodeDialect(
      'interface W { city: string }\nconst w: W = await tools.getWeather({ city: "x" });',
    );
    expect(detection.dialect).toBe("vercel");
  });

  it("does not claim plain Pi JavaScript", () => {
    const detection = detectCodemodeDialect('const r = await tools.read({ path: "a" });');
    expect(detection.dialect).toBe("unknown");
  });
});

describe("compilePtcDialect", () => {
  it("maps a bracket access to Pi's identifier", () => {
    const result = compilePtcDialect('await tools["web-search"]({ q: "x" });', { tools: ["web-search"] });
    expect(result.changed).toBe(true);
    expect(result.rewrites).toBe(1);
    expect(result.code).toBe("await tools.web_search({ q: \"x\" });");
    expect(result.warnings).toEqual([]);
  });

  it("resolves a dotted raw name fuzzily to Pi's identifier rule", () => {
    const result = compilePtcDialect('await tools["mcp.dev.radius.search"]({ query: "x" });', {
      tools: ["mcp__dev-radius__search"],
    });
    expect(result.changed).toBe(true);
    expect(result.code).toBe('await tools.mcp__dev_radius__search({ query: "x" });');
    expect(result.warnings).toEqual([]);
  });

  it("preserves optional chaining when rewriting", () => {
    const result = compilePtcDialect('const b = tools?.["other-tool"];', { tools: ["other-tool"] });
    expect(result.changed).toBe(true);
    expect(result.code).toBe("const b = tools?.other_tool;");
  });

  it("leaves a locally bound tools object alone", () => {
    const code = 'const tools = { "my-key": 1 };\nlog(tools["my-key"]);';
    const result = compilePtcDialect(code, { tools: ["my-key"] });
    expect(result.changed).toBe(false);
    expect(result.code).toBe(code);
  });

  it("still warns about dynamic import when tools is shadowed", () => {
    const result = compilePtcDialect('const tools = {};\nawait import("node:fs");');
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("import");
  });

  it("still warns about ToolCallError when tools is shadowed", () => {
    const result = compilePtcDialect('const tools = {};\nif (x instanceof ToolCallError) {}');
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("ToolCallError");
  });

  it("rewrites Object.keys(tools) to ALL_TOOLS", () => {
    const result = compilePtcDialect("const names = Object.keys(tools);");
    expect(result.changed).toBe(true);
    expect(result.rewrites).toBe(1);
    expect(result.code).toBe("const names = ALL_TOOLS.map((__ptc_tool) => __ptc_tool.name);");
  });

  it("warns exactly once about ToolCallError", () => {
    const result = compilePtcDialect(
      'try { await tools.foo({}); } catch (e) { if (e instanceof ToolCallError) console.log(e.toolName); }',
    );
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("ToolCallError");
  });

  it("warns exactly once about dynamic import", () => {
    const result = compilePtcDialect('const fs = await import("node:fs");');
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("import");
  });

  it("does not duplicate warnings for repeated occurrences", () => {
    const result = compilePtcDialect(
      'const fs = await import("node:fs");\nconst p = await import("node:path");\ntry { await tools.foo({}); } catch (e) { if (e instanceof ToolCallError) {} }',
    );
    expect(result.warnings.length).toBe(2);
  });

  it("warns once per unresolved raw name, not per occurrence", () => {
    const result = compilePtcDialect('tools["nope"]({});\ntools["nope"]({});', { tools: ["bash"] });
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("nope");
  });

  it("returns unparseable source unchanged", () => {
    const result = compilePtcDialect("const = ;", { tools: ["bash"] });
    expect(result.code).toBe("const = ;");
    expect(result.changed).toBe(false);
    expect(result.rewrites).toBe(0);
  });

  it("is idempotent", () => {
    const once = compilePtcDialect('await tools["web-search"]({ q: "x" });', { tools: ["web-search"] });
    const twice = compilePtcDialect(once.code, { tools: ["web-search"] });
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });

  it("maps a raw name without a catalog and does not warn", () => {
    const result = compilePtcDialect('await tools["web-search"]({ q: "x" });');
    expect(result.changed).toBe(true);
    expect(result.code).toBe("await tools.web_search({ q: \"x\" });");
    expect(result.warnings).toEqual([]);
  });
});
