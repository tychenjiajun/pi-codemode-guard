import { describe, expect, it } from "vitest";

import { compileCloudflareDialect, cloudflareSanitize } from "./cloudflare.ts";
import { detectCodemodeDialect } from "./dialect.ts";

describe("cloudflareSanitize", () => {
  it("matches @cloudflare/codemode sanitizeToolName", () => {
    expect(cloudflareSanitize("my-tool")).toBe("my_tool");
    expect(cloudflareSanitize("3d-render")).toBe("_3d_render");
    expect(cloudflareSanitize("delete")).toBe("delete_");
    expect(cloudflareSanitize("mcp.dev.radius.search")).toBe("mcp_dev_radius_search");
    expect(cloudflareSanitize("a+b")).toBe("ab");
    expect(cloudflareSanitize("")).toBe("_");
  });
});

describe("detectCodemodeDialect: cloudflare", () => {
  it("detects the codemode platform namespace", () => {
    const detection = detectCodemodeDialect('const w = await codemode.getWeather({ city: "London" });');
    expect(detection.dialect).toBe("cloudflare");
    expect(detection.signals).toContain("codemode.<tool>");
  });

  it("detects codemode.search/describe/run/step", () => {
    expect(detectCodemodeDialect('await codemode.search("pull request");').signals).toContain("codemode.search");
    expect(detectCodemodeDialect('await codemode.describe("github.list");').signals).toContain("codemode.describe");
    expect(detectCodemodeDialect('await codemode.run("saved");').signals).toContain("codemode.run");
    expect(detectCodemodeDialect("await codemode.step('x', () => 1);").signals).toContain("codemode.step");
  });

  it("detects the bare async arrow wrapper", () => {
    const detection = detectCodemodeDialect('async () => {\n  await state.writeJson("/x", 1);\n}');
    expect(detection.dialect).toBe("cloudflare");
    expect(detection.signals).toContain("async-arrow-wrapper");
  });

  it("prefers the Pi signals over the wrapper", () => {
    expect(detectCodemodeDialect('async () => {\n  return await searchTools("x");\n}').dialect).toBe("pi");
  });

  it("leaves plain Pi and unknown code alone", () => {
    expect(detectCodemodeDialect('const r = await tools.bash({ command: "ls" });').dialect).toBe("unknown");
    expect(detectCodemodeDialect("async () => 1;").dialect).toBe("cloudflare");
  });
});

describe("compileCloudflareDialect", () => {
  it("maps the default codemode namespace to a Pi tool", () => {
    const result = compileCloudflareDialect('await codemode.getWeather({ location: "London" });', {
      tools: ["getWeather"],
    });
    expect(result.changed).toBe(true);
    expect(result.rewrites).toBe(1);
    expect(result.code).toBe('await tools.getWeather({ location: "London" });');
  });

  it("falls back to the method name without a catalog", () => {
    const result = compileCloudflareDialect('await codemode.getWeather({ location: "London" });', { tools: [] });
    expect(result.code).toBe('await tools.getWeather({ location: "London" });');
  });

  it("maps a sanitized reserved word back to the Pi identifier", () => {
    const result = compileCloudflareDialect("await codemode.delete_({ id: 1 });", { tools: ["delete"] });
    expect(result.code).toBe("await tools.delete({ id: 1 });");
  });

  it("maps a digit-leading sanitized name to Pi's identifier rule", () => {
    const result = compileCloudflareDialect("await codemode._3d_render({ id: 1 });", { tools: ["3d-render"] });
    expect(result.code).toBe("await tools._d_render({ id: 1 });");
  });

  it("maps a named provider namespace", () => {
    const result = compileCloudflareDialect('await github.list_pull_requests({ repo: "a" });', {
      tools: ["github.list_pull_requests"],
    });
    expect(result.code).toBe('await tools.github_list_pull_requests({ repo: "a" });');
  });

  it("fuzzy-matches a named provider against a flattened MCP tool", () => {
    const result = compileCloudflareDialect('await mcp.dev_radius.search({ query: "x" });', {
      tools: ["mcp__dev-radius__search"],
    });
    expect(result.code).toBe('await tools.mcp__dev_radius__search({ query: "x" });');
  });

  it("compiles codemode.search to a searchTools shim with Cloudflare's result shape", () => {
    const result = compileCloudflareDialect('const matches = await codemode.search("pull request");', { tools: [] });
    expect(result.changed).toBe(true);
    expect(result.code.startsWith("const matches = await (async (__cm_query)")).toBe(true);
    expect(result.code).toContain("searchTools(");
    expect(result.code).toContain("results:");
    expect(result.code).toContain("path:");
  });

  it("compiles codemode.describe to a describeTool shim", () => {
    const result = compileCloudflareDialect("const docs = await codemode.describe(matches.results[0].path);", {
      tools: [],
    });
    expect(result.changed).toBe(true);
    expect(result.code).toContain("describeTool(");
    expect(result.code).toContain("types:");
  });

  it("warns about codemode.run and leaves it unchanged", () => {
    const result = compileCloudflareDialect('await codemode.run("saved");', { tools: [] });
    expect(result.changed).toBe(false);
    expect(result.warnings.some((warning) => warning.includes("codemode.run"))).toBe(true);
  });

  it("leaves JavaScript globals and Pi helpers alone even when the catalog matches", () => {
    const code =
      'Math.max(1, 2); JSON.stringify({}); console.log("x"); Promise.all([]); Object.keys(tools); searchTools("x");';
    const result = compileCloudflareDialect(code, {
      tools: ["max", "stringify", "log", "all", "keys", "searchTools"],
    });
    expect(result.changed).toBe(false);
  });

  it("does not rewrite a locally bound namespace", () => {
    const code = 'const state = { readFile: () => 1 };\nstate.readFile("/x");';
    const result = compileCloudflareDialect(code, { tools: ["state.readFile"] });
    expect(result.changed).toBe(false);
  });

  it("leaves an unresolved named namespace and warns when a catalog is present", () => {
    const result = compileCloudflareDialect('await state.readFile("/missing");', { tools: ["bash"] });
    expect(result.changed).toBe(false);
    expect(result.warnings.some((warning) => warning.includes("state.readFile"))).toBe(true);
  });

  it("returns unchanged for unparseable source", () => {
    expect(compileCloudflareDialect("const = ;", { tools: [] }).changed).toBe(false);
  });

  it("is idempotent", () => {
    const once = compileCloudflareDialect('await codemode.getWeather({ city: "London" });', {
      tools: ["getWeather"],
    });
    const twice = compileCloudflareDialect(once.code, { tools: ["getWeather"] });
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });
});