import { describe, expect, it } from "vitest";

import { detectCodemodeDialect } from "./dialect.ts";

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
    const code = "const tools = { orders: { lookup: (id) => ({ id }) } };\nconst r = tools.orders.lookup(1);";
    expect(detectCodemodeDialect(code).dialect).toBe("unknown");
  });

  it("does not route Object.keys(tools) to OpenCode when tools is bound", () => {
    const detection = detectCodemodeDialect("const tools = {};\nconst names = Object.keys(tools);");
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
