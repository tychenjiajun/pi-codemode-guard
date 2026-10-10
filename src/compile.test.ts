import { describe, expect, it } from "vitest";

import { compileCodemodeSource } from "./compile.ts";

describe("compileCodemodeSource", () => {
  it("strips a fence and adds the missing await", () => {
    const result = compileCodemodeSource(
      '```js\nconst file = tools.read({ path: "package.json" });\ntext(file);\n```',
    );
    expect(result.changed).toBe(true);
    expect(result.code).toBe('const file = await tools.read({ path: "package.json" });\ntext(file);');
    expect(result.passes).toContain("strip-code-fence");
    expect(result.passes).toContain("await-async-calls(1)");
  });

  it("normalizes the options line and adds the await", () => {
    const result = compileCodemodeSource(
      "```javascript\n// @options {'max_output_tokens': 2000}\nconst x = searchTools('feishu');\ntext(x);\n```",
    );
    expect(result.code).toBe(
      '// @options: {"max_output_tokens": 2000}\nconst x = await searchTools(\'feishu\');\ntext(x);',
    );
    expect(result.passes).toEqual(
      expect.arrayContaining(["strip-code-fence", "normalize-options-line", "await-async-calls(1)"]),
    );
  });

  it("unwraps a redundant async IIFE", () => {
    const result = compileCodemodeSource(
      '(async () => {\n  const r = await tools.bash({ command: "ls" });\n  return r.output;\n})();',
    );
    expect(result.passes).toContain("unwrap-iife");
    expect(result.code).toBe('const r = await tools.bash({ command: "ls" });\n  return r.output;');
  });

  it("compiles a JSON tool-call program", () => {
    const result = compileCodemodeSource('[{"tool":"read","args":{"path":"a"}},{"tool":"bash","args":{"command":"ls"}}]');
    expect(result.passes).toContain("compile-json-program");
    expect(result.code).toContain('await tools.read({"path":"a"})');
    expect(result.code).toContain('await tools.bash({"command":"ls"})');
  });

  it("rewrites bracket tool identifiers", () => {
    const result = compileCodemodeSource('const r = tools["mcp__dev-radius__search"]({ query: "x" });');
    expect(result.passes).toContain("rewrite-tool-identifiers");
    expect(result.code).toBe('const r = await tools.mcp__dev_radius__search({ query: "x" });');
  });

  it("fixes the unawaited searchTools bug from pi issue #10555", () => {
    const result = compileCodemodeSource(
      "const hits = searchTools('feishu', { limit: 20 });\nconsole.log('feishu:', JSON.stringify(hits));",
    );
    expect(result.changed).toBe(true);
    expect(result.code).toContain('const hits = await searchTools(\'feishu\', { limit: 20 });');
    expect(result.code).toContain("JSON.stringify(hits)");
  });

  it("leaves an already-valid script alone", () => {
    const code = 'const file = await tools.read({ path: "a" });\ntext(file);';
    const result = compileCodemodeSource(code);
    expect(result.changed).toBe(false);
    expect(result.passes).toEqual([]);
    expect(result.parsed).toBe(true);
  });

  it("detects and compiles the OpenCode dialect", () => {
    const result = compileCodemodeSource(
      'const page = await tools.$codemode.search({ query: "file" });\nconst file = await tools.orders.lookup({ id: page.items[0].path });\nreturn file;',
      { tools: ["orders.lookup", "read", "bash"] },
    );
    expect(result.dialect).toBe("opencode");
    expect(result.passes).toContain("opencode-dialect(2)");
    expect(result.code).toContain("searchTools(__cm_query");
    expect(result.code).toContain("tools.orders_lookup");
  });

  it("does not run the OpenCode pass on Pi code", () => {
    const result = compileCodemodeSource('const hits = await searchTools("x");\nreturn hits;');
    expect(result.dialect).toBe("pi");
    expect(result.passes.some((pass) => pass.startsWith("opencode-dialect"))).toBe(false);
  });

  it("compiles the Cloudflare agents codemode dialect", () => {
    const source = [
      "async () => {",
      '  const matches = await codemode.search("order status");',
      '  const order = await codemode.lookupOrder({ id: matches.results[0].path });',
      '  await state.writeJson("/orders.json", order);',
      "  return order;",
      "}",
    ].join("\n");
    const result = compileCodemodeSource(source, { tools: ["lookupOrder", "state.writeJson"] });
    expect(result.dialect).toBe("cloudflare");
    expect(result.passes).toContain("unwrap-iife");
    expect(result.passes).toContain("cloudflare-dialect(3)");
    expect(result.code).toContain("searchTools(");
    expect(result.code).toContain("tools.lookupOrder(");
    expect(result.code).toContain("tools.state_writeJson(");
    expect(result.code).not.toContain("codemode.");
    expect(result.code).not.toContain("async () =>");
  });

  it("does not run the Cloudflare pass on Pi code", () => {
    const result = compileCodemodeSource('const hits = await searchTools("x");\nreturn hits;');
    expect(result.dialect).toBe("pi");
    expect(result.passes.some((pass) => pass.startsWith("cloudflare-dialect"))).toBe(false);
  });

  it("compiles the TanStack AI code mode dialect", () => {
    const source = [
      'const cities: Array<string> = ["Tokyo", "Paris"];',
      "const results = await Promise.all(",
      "  cities.map((city) => external_getWeather({ location: city })),",
      ");",
      "return results;",
    ].join("\n");
    const result = compileCodemodeSource(source, { tools: ["getWeather"] });
    expect(result.dialect).toBe("tanstack");
    expect(result.passes).toContain("tanstack-typescript");
    expect(result.passes).toContain("tanstack-dialect(1)");
    expect(result.code).not.toContain("external_");
    expect(result.code).not.toContain("Array<string>");
    expect(result.code).toContain("tools.getWeather({ location: city })");
  });

  it("awaits a TanStack binding that forgot the await", () => {
    const result = compileCodemodeSource(
      'const w = external_getWeather({ location: "London" });\ntext(w);',
      { tools: ["getWeather"] },
    );
    expect(result.dialect).toBe("tanstack");
    expect(result.code).toContain('const w = await tools.getWeather({ location: "London" });');
    expect(result.passes).toContain("await-async-calls(1)");
  });

  it("does not run the TanStack pass on Pi code", () => {
    const result = compileCodemodeSource('const hits = await searchTools("x");\nreturn hits;');
    expect(result.dialect).toBe("pi");
    expect(result.passes.some((pass) => pass.startsWith("tanstack"))).toBe(false);
  });

  it("compiles TanStack TypeScript idempotently", () => {
    const once = compileCodemodeSource("const x: number = 1;\nreturn await external_getWeather({ x });", {
      tools: ["getWeather"],
    });
    const twice = compileCodemodeSource(once.code, { tools: ["getWeather"] });
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });

  it("compiles the Vercel AI SDK code mode dialect", () => {
    const source = [
      "interface Weather { temp: number }",
      'const w: Weather = await tools["get-weather"]({ location: "London" });',
      "return w;",
    ].join("\n");
    const result = compileCodemodeSource(source, { tools: ["get-weather"] });
    expect(result.dialect).toBe("vercel");
    expect(result.passes).toContain("vercel-typescript");
    expect(result.passes).toContain("vercel-dialect(1)");
    expect(result.code).not.toContain("interface");
    expect(result.code).not.toContain(": Weather");
    expect(result.code).not.toContain('tools["');
    expect(result.code).toContain('await tools.get_weather({ location: "London" });');
  });

  it("strips TypeScript around an optional-chained Vercel call", () => {
    const result = compileCodemodeSource(
      'interface Q { q: string }\nconst r: Q = await tools?.["web-search"]({ q: "pi" });\nreturn r;',
      { tools: ["web-search"] },
    );
    expect(result.dialect).toBe("vercel");
    expect(result.passes).toContain("vercel-typescript");
    expect(result.code).toContain('await tools?.web_search({ q: "pi" })');
    expect(result.code).not.toContain("interface");
  });

  it("awaits a Vercel tool call that forgot the await", () => {
    const result = compileCodemodeSource(
      'const w: unknown = tools["get-weather"]({ location: "London" });\ntext(w);',
      { tools: ["get-weather"] },
    );
    expect(result.dialect).toBe("vercel");
    expect(result.passes).toContain("vercel-typescript");
    expect(result.code).toContain('const w = await tools.get_weather({ location: "London" });');
    expect(result.passes).toContain("await-async-calls(1)");
  });

  it("does not run the Vercel pass on Pi code", () => {
    const result = compileCodemodeSource('const hits = await searchTools("x");\nreturn hits;');
    expect(result.dialect).toBe("pi");
    expect(result.passes.some((pass) => pass.startsWith("vercel"))).toBe(false);
  });

  it("compiles Vercel TypeScript idempotently", () => {
    const once = compileCodemodeSource('const n: number = 1;\nreturn tools["lookup-user"]({ id: n });', {
      tools: ["lookup-user"],
    });
    const twice = compileCodemodeSource(once.code, { tools: ["lookup-user"] });
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });

  it("compiles the DeepSeek Harness PTC dialect", () => {
    const source = [
      "interface Weather { temp: number }",
      "const names = Object.keys(tools);",
      'const w: Weather = await tools["get-weather"]({ location: "London" });',
      "return { names, w };",
    ].join("\n");
    const result = compileCodemodeSource(source, { tools: ["get-weather"] });
    expect(result.dialect).toBe("ptc");
    expect(result.passes).toContain("ptc-typescript");
    expect(result.passes).toContain("ptc-dialect(2)");
    expect(result.code).toContain('await tools.get_weather({ location: "London" })');
    expect(result.code).toContain("ALL_TOOLS.map((__ptc_tool) => __ptc_tool.name)");
    expect(result.code).not.toContain("interface");
    expect(result.code).not.toContain(": Weather");
  });

  it("compiles PTC TypeScript idempotently", () => {
    const source = [
      "interface Weather { temp: number }",
      "const names = Object.keys(tools);",
      'const w: Weather = await tools["get-weather"]({ location: "London" });',
      "return { names, w };",
    ].join("\n");
    const once = compileCodemodeSource(source, { tools: ["get-weather"] });
    const twice = compileCodemodeSource(once.code, { tools: ["get-weather"] });
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });

  it("does not run the PTC pass on Pi code", () => {
    const result = compileCodemodeSource('const hits = await searchTools("x");\nreturn hits;');
    expect(result.dialect).toBe("pi");
    expect(result.passes.some((pass) => pass.startsWith("ptc-"))).toBe(false);
  });

  it("surfaces PTC-only feature warnings through compileCodemodeSource", () => {
    const source = [
      'const fs = await import("node:fs");',
      "try {",
      '  const w = await tools["get-weather"]({ location: "London" });',
      "  return w;",
      "} catch (e) {",
      "  if (e instanceof ToolCallError) return String(e);",
      "  throw e;",
      "}",
    ].join("\n");
    const result = compileCodemodeSource(source, { tools: ["get-weather"] });
    expect(result.dialect).toBe("ptc");
    expect(result.warnings.some((warning) => warning.includes("ToolCallError"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("import()"))).toBe(true);
  });

  it("awaits a Cloudflare search shim that forgot the await", () => {
    const result = compileCodemodeSource('const m = codemode.search("x");\ntext(m);', { tools: [] });
    expect(result.dialect).toBe("cloudflare");
    expect(result.code).toContain("const m = await (async (__cm_query)");
    expect(result.passes).toContain("await-async-calls(1)");
  });

  it("surfaces Cloudflare codemode.run warnings even without a rewrite", () => {
    const result = compileCodemodeSource('async () => {\n  await codemode.run("saved");\n}', { tools: [] });
    expect(result.dialect).toBe("cloudflare");
    expect(result.warnings.some((warning) => warning.includes("codemode.run"))).toBe(true);
  });

  it("never throws on unparseable source, and only runs lexical passes", () => {
    const result = compileCodemodeSource("```js\nconst = ;\n```");
    expect(result.parsed).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.code).toBe("const = ;");
  });

  it("is idempotent", () => {
    const once = compileCodemodeSource('```js\nconst x = tools.read({ path: "a" });\ntext(x);\n```');
    const twice = compileCodemodeSource(once.code);
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });

  it("strips nested fences in one compile and is idempotent", () => {
    const once = compileCodemodeSource(
      '```js\n```javascript\nconst x = await tools.read({ path: "a" });\n```\n```',
    );
    expect(once.code).toBe('const x = await tools.read({ path: "a" });');
    expect(once.code).not.toContain("```");
    const twice = compileCodemodeSource(once.code);
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });

  it("propagates fence warnings from the strip pass", () => {
    const unterminated = compileCodemodeSource("```js\nconst x = 1;");
    expect(unterminated.changed).toBe(true);
    expect(unterminated.code).toBe("const x = 1;");
    expect(unterminated.warnings).toContain("removed an unterminated code fence");
  });

  it("warns when it removes an empty code fence", () => {
    const result = compileCodemodeSource("```js\n```");
    expect(result.changed).toBe(true);
    expect(result.code).toBe("");
    expect(result.passes).toContain("strip-code-fence");
    expect(result.warnings.some((warning) => warning.includes("empty code fence"))).toBe(true);
  });

  it("lists the options pass even when the script is byte-identical", () => {
    const result = compileCodemodeSource('// @options: {"timeout_ms": 30000}\n');
    expect(result.changed).toBe(false);
    expect(result.passes).toEqual(["normalize-options-line"]);
    expect(result.parsed).toBe(true);
  });

  it("reports the pi dialect for an options-only script", () => {
    const result = compileCodemodeSource('// @options: {"timeout_ms": 30000}\n');
    expect(result.dialect).toBe("pi");
  });

  it("surfaces OpenCode warnings even when the pass makes no change", () => {
    const result = compileCodemodeSource('await tools.$codemode.describe({ target: "x" });');
    expect(result.dialect).toBe("opencode");
    expect(result.changed).toBe(false);
    expect(result.code).toBe('await tools.$codemode.describe({ target: "x" });');
    expect(result.warnings.some((warning) => warning.includes("$codemode.describe"))).toBe(true);
  });

  it("strips generic TypeScript when no dialect claims the script", () => {
    const once = compileCodemodeSource("const x: number = 1;\nreturn x;");
    expect(once.changed).toBe(true);
    expect(once.code).toBe("const x = 1;\nreturn x;");
    expect(once.passes).toContain("strip-typescript");
    expect(once.parsed).toBe(true);
    const twice = compileCodemodeSource(once.code);
    expect(twice.changed).toBe(false);
    expect(twice.passes).not.toContain("strip-typescript");
    expect(twice.code).toBe(once.code);
  });

  it("does not run the generic strip when a dialect TypeScript pass already ran", () => {
    const result = compileCodemodeSource('const n: number = 1;\nreturn tools["lookup-user"]({ id: n });', {
      tools: ["lookup-user"],
    });
    expect(result.passes).toContain("vercel-typescript");
    expect(result.passes).not.toContain("strip-typescript");
    expect(result.parsed).toBe(true);
  });

  it("resolves bracket access against the tool catalog", () => {
    const options = { tools: ["mcp__dev_radius_search"] };
    const once = compileCodemodeSource('tools["mcp.dev.radius.search"]({ q: 1 });', options);
    expect(once.code).toBe("await tools.mcp__dev_radius_search({ q: 1 });");
    expect(once.passes).toContain("rewrite-tool-identifiers");
    const twice = compileCodemodeSource(once.code, options);
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });

  it("falls back to the naive identifier without a catalog", () => {
    const result = compileCodemodeSource('tools["mcp.dev.radius.search"]({ q: 1 });');
    expect(result.code).toBe("await tools.mcp_dev_radius_search({ q: 1 });");
    expect(result.warnings).toEqual([]);
  });

  it("stays warning-free when a bracket name is not in the catalog", () => {
    const result = compileCodemodeSource('tools["a-b"]({});', { tools: ["read"] });
    expect(result.code).toBe("await tools.a_b({});");
    expect(result.warnings).toEqual([]);
  });

  it("keeps property access on a tool handle unchanged through the pipeline", () => {
    const source = "text(tools.read.length > 0);\ntext(tools.bash.output);";
    const options = { tools: ["read", "bash", "subagent_start"] };
    const once = compileCodemodeSource(source, options);
    expect(once.code).toBe(source);
    expect(once.changed).toBe(false);
    expect(once.warnings.some((w) => w.includes("could not resolve OpenCode tool path"))).toBe(false);
    const twice = compileCodemodeSource(once.code, options);
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });

  it("keeps `tools.subagent_start.name` unchanged through the pipeline", () => {
    const source = "text(tools.subagent_start.name);";
    const options = { tools: ["read", "bash", "subagent_start"] };
    const once = compileCodemodeSource(source, options);
    expect(once.code).toBe(source);
    expect(once.changed).toBe(false);
    expect(once.warnings.some((w) => w.includes("could not resolve OpenCode tool path"))).toBe(false);
    const twice = compileCodemodeSource(once.code, options);
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });
});

describe("JSON tool-call programs", () => {
  it("awaits raw-JavaScript string steps and is idempotent (pi #10555)", () => {
    const input = '["text(tools.read({path: \\"a\\"}))"]';
    const once = compileCodemodeSource(input);
    expect(once.parsed).toBe(true);
    expect(once.dialect).toBe("unknown");
    expect(once.passes).toContain("compile-json-program");
    expect(once.code).toBe('text(await tools.read({path: "a"}))');
    const twice = compileCodemodeSource(once.code);
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
    const thrice = compileCodemodeSource(twice.code);
    expect(thrice.code).toBe(once.code);
  });

  it("rewrites bracket access in string steps and is idempotent", () => {
    const input = '["tools[\\"a-b\\"]({})"]';
    const once = compileCodemodeSource(input);
    expect(once.parsed).toBe(true);
    expect(once.dialect).toBe("unknown");
    expect(once.passes).toContain("compile-json-program");
    expect(once.code).toBe("await tools.a_b({})");
    const twice = compileCodemodeSource(once.code);
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });
});
