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
