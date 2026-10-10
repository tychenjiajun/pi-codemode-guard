import { describe, expect, it } from "vitest";

import { compileCodemodeSource } from "../compile.ts";
import { detectCodemodeDialect } from "./detect.ts";
import { LOCAL_EMPTY_TOOLS_KEYS_SCRIPT, LOCAL_TOOLS_SCRIPT } from "../test-support.ts";

describe("detectCodemodeDialect: lexical precision", () => {
  it("does not match `toolset` or the bare word `tools` as Vercel", () => {
    const detection = detectCodemodeDialect('type A = toolset;\nconst s = "tools rock";\nfunction f(): void {}');
    expect(detection.dialect).toBe("unknown");
    expect(detection.signals).not.toContain("vercel:tools.<name>");
  });

  it("still matches tools.<name> and tools[\"name\"] in unparseable TypeScript", () => {
    expect(
      detectCodemodeDialect("function f(): void {\n  await tools.getWeather({});\n}").signals,
    ).toContain("vercel:tools.<name>");
    expect(
      detectCodemodeDialect('function g(): void {\n  await tools["web-search"]({});\n}').signals,
    ).toContain("vercel:tools.<name>");
    expect(
      detectCodemodeDialect('function h(): void {\n  await tools?.["web-search"]({});\n}').signals,
    ).toContain("vercel:tools.<name>");
  });

  it("does not treat a comment-only external_ mention as TanStack", () => {
    const detection = detectCodemodeDialect("// we should call external_foo here\nconst n: number = 1;");
    expect(detection.dialect).toBe("unknown");
    expect(detection.signals).not.toContain("external_<tool>");
  });

  it("does not treat a block-comment-only external_ mention as TanStack", () => {
    const detection = detectCodemodeDialect("/* external_foo */\nconst n: number = 1;");
    expect(detection.dialect).toBe("unknown");
    expect(detection.signals).not.toContain("external_<tool>");
  });
});

describe("detectCodemodeDialect: declaration positions", () => {
  it("does not detect TanStack from a function parameter declaration", () => {
    const detection = detectCodemodeDialect("function g(external_foo) {}");
    expect(detection.dialect).not.toBe("tanstack");
    expect(detection.signals).not.toContain("external_<tool>");
  });

  it("does not detect TanStack from a catch parameter declaration", () => {
    const detection = detectCodemodeDialect("try {} catch (external_foo) {}");
    expect(detection.dialect).not.toBe("tanstack");
    expect(detection.signals).not.toContain("external_<tool>");
  });

  it("does not detect TanStack from a non-shorthand property key", () => {
    const detection = detectCodemodeDialect("const o = { external_foo: 1 };");
    expect(detection.dialect).not.toBe("tanstack");
    expect(detection.signals).not.toContain("external_<tool>");
  });

  it("does not detect TanStack from a variable declaration id", () => {
    const detection = detectCodemodeDialect("const external_foo = 1;");
    expect(detection.dialect).not.toBe("tanstack");
    expect(detection.signals).not.toContain("external_<tool>");
  });

  it("still detects TanStack from a genuine shorthand reference", () => {
    const detection = detectCodemodeDialect("const o = { external_foo };");
    expect(detection.dialect).toBe("tanstack");
    expect(detection.signals).toContain("external_<tool>");
  });
});

describe("detectCodemodeDialect: shadowed tools", () => {
  it("does not route a locally bound tools object to OpenCode", () => {
    const code = LOCAL_TOOLS_SCRIPT;
    expect(detectCodemodeDialect(code).dialect).toBe("unknown");
  });

  it("does not route Object.keys(tools) to OpenCode when tools is bound", () => {
    const detection = detectCodemodeDialect(LOCAL_EMPTY_TOOLS_KEYS_SCRIPT);
    expect(detection.dialect).not.toBe("opencode");
    expect(detection.signals).not.toContain("Object.keys(tools)");
  });

  it("keeps PTC's global signals even when tools is bound", () => {
    const code = "const tools = {};\nif (e instanceof ToolCallError) {}";
    expect(detectCodemodeDialect(code).dialect).toBe("ptc");
  });
});

describe("detectCodemodeDialect: options context", () => {
  it("detects pi when the caller stripped the @options line", () => {
    expect(detectCodemodeDialect("return 1;", { hadOptionsLine: true }).dialect).toBe("pi");
    expect(detectCodemodeDialect("return 1;", { hadOptionsLine: true }).signals).toContain("pi:@options");
  });

  it("still reports unknown without the options context", () => {
    expect(detectCodemodeDialect("return 1;").dialect).toBe("unknown");
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

describe("detectCodemodeDialect: codex", () => {
  it("detects the @exec pragma through the caller's context flag", () => {
    const detection = detectCodemodeDialect('const r = await tools.read({ path: "a" });', { hadExecLine: true });
    expect(detection.dialect).toBe("codex");
    expect(detection.signals).toContain("codex:@exec");
  });

  it("detects the Codex-only helpers", () => {
    expect(detectCodemodeDialect("yield_control();").dialect).toBe("codex");
    expect(detectCodemodeDialect('notify("done");').dialect).toBe("codex");
    expect(detectCodemodeDialect("generatedImage(block);").dialect).toBe("codex");
  });

  it("does not mistake a bare tools.<name> call for Codex", () => {
    expect(detectCodemodeDialect('const r = await tools.read({ path: "a" });').dialect).toBe("unknown");
  });
});

describe("detectCodemodeDialect: opencode", () => {
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

  it("does not route a locally bound tools object to the OpenCode dialect", () => {
    const code = LOCAL_TOOLS_SCRIPT;
    const detection = detectCodemodeDialect(code);
    expect(detection.dialect).not.toBe("opencode");
    expect(detection.signals).not.toContain("tools.<namespace>.<tool>");
  });

  it("does not route Object.keys(tools) to OpenCode when tools is locally bound", () => {
    const detection = detectCodemodeDialect(LOCAL_EMPTY_TOOLS_KEYS_SCRIPT);
    expect(detection.dialect).not.toBe("opencode");
    expect(detection.signals).not.toContain("Object.keys(tools)");
  });

  it("names a non-search $codemode member signal generically", () => {
    const detection = detectCodemodeDialect("await tools.$codemode.describe({});");
    expect(detection.dialect).toBe("opencode");
    expect(detection.signals).toContain("$codemode.<member>");
    expect(detection.signals).not.toContain("$codemode.search");
  });
});

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

describe("detectCodemodeDialect: tanstack", () => {
  it("detects bare external_<tool> calls", () => {
    const detection = detectCodemodeDialect('const w = await external_getWeather({ location: "London" });');
    expect(detection.dialect).toBe("tanstack");
    expect(detection.signals).toContain("external_<tool>");
  });

  it("detects TypeScript source that acorn cannot parse", () => {
    const detection = detectCodemodeDialect(
      'const city: string = "London";\nconst w = await external_getWeather({ location: city });',
    );
    expect(detection.dialect).toBe("tanstack");
    expect(detection.signals).toContain("external_<tool>");
  });

  it("does not mistake a Pi tool named external_* for the dialect", () => {
    expect(detectCodemodeDialect('const r = await tools.external_foo({ a: 1 });').dialect).toBe("unknown");
  });

  it("prefers OpenCode over TanStack", () => {
    const code = 'await tools.$codemode.search({ query: "x" });\nawait external_foo({});';
    expect(detectCodemodeDialect(code).dialect).toBe("opencode");
  });
});

describe("detectCodemodeDialect: vercel", () => {
  it("detects TypeScript with a bare tools.<name> call", () => {
    const detection = detectCodemodeDialect(
      'const city: string = "London";\nconst w = await tools.getWeather({ location: city });',
    );
    expect(detection.dialect).toBe("vercel");
    expect(detection.signals).toContain("vercel:tools.<name>");
  });

  it("detects TypeScript with a tools[\"name\"] bracket access", () => {
    const detection = detectCodemodeDialect(
      'type Query = { q: string };\nconst r = await tools["web-search"]({ q: "pi" });',
    );
    expect(detection.dialect).toBe("vercel");
    expect(detection.signals).toContain("vercel:tools.<name>");
  });

  it("prefers TanStack's external_ binding over the Vercel signal", () => {
    const code = 'const city: string = "x";\nawait external_getWeather({ location: city });\nawait tools["web-search"]({});';
    expect(detectCodemodeDialect(code).dialect).toBe("tanstack");
  });

  it("prefers an OpenCode nested path over the Vercel signal", () => {
    const code = 'interface Order { id: string }\nconst o = await tools.orders.lookup({ id: "1" });';
    const detection = detectCodemodeDialect(code);
    expect(detection.dialect).toBe("opencode");
    expect(detection.signals).toContain("tools.<namespace>.<tool>");
  });

  it("does not claim plain Pi JavaScript", () => {
    const detection = detectCodemodeDialect('const r = await tools.read({ path: "a" });');
    expect(detection.dialect).toBe("unknown");
    expect(detection.signals).not.toContain("vercel:tools.<name>");
  });

  it("detects optional-chained TypeScript tool access", () => {
    const detection = detectCodemodeDialect(
      'interface Q { q: string }\nconst r = await tools?.["web-search"]({ q: "pi" });',
    );
    expect(detection.dialect).toBe("vercel");
    expect(detection.signals).toContain("vercel:tools.<name>");
  });

  it("prefers Cloudflare over Vercel when the codemode namespace is present", () => {
    const code = 'interface A {}\nawait codemode.search("x");\nawait tools.getWeather({});';
    expect(detectCodemodeDialect(code).dialect).toBe("cloudflare");
  });
});
