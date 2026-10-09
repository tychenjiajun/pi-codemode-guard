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
});
