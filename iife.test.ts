import { describe, expect, it } from "vitest";

import { unwrapIIFE } from "./iife.ts";

describe("unwrapIIFE", () => {
  it("unwraps an async arrow IIFE", () => {
    const result = unwrapIIFE("(async () => {\n  const x = 1;\n  return x;\n})();");
    expect(result.changed).toBe(true);
    expect(result.code).toBe("const x = 1;\n  return x;");
  });

  it("unwraps an awaited async arrow IIFE", () => {
    const result = unwrapIIFE("await (async () => {\n  return 1;\n})();");
    expect(result.code).toBe("return 1;");
  });

  it("unwraps a void async arrow IIFE", () => {
    const result = unwrapIIFE("void (async () => {\n  return 1;\n})();");
    expect(result.code).toBe("return 1;");
  });

  it("unwraps an async function IIFE", () => {
    const result = unwrapIIFE("(async function () {\n  return 1;\n})();");
    expect(result.code).toBe("return 1;");
  });

  it("unwraps a bare async arrow (Cloudflare agents codemode shape)", () => {
    const result = unwrapIIFE("async () => {\n  const x = await codemode.getWeather({ city: 'London' });\n  return x;\n}");
    expect(result.changed).toBe(true);
    expect(result.code).toBe("const x = await codemode.getWeather({ city: 'London' });\n  return x;");
  });

  it("does not unwrap when there are other statements", () => {
    const code = "(async () => {\n  return 1;\n})();\nconst x = 2;";
    expect(unwrapIIFE(code).changed).toBe(false);
  });

  it("does not unwrap a synchronous IIFE", () => {
    const code = "(() => 1)();";
    expect(unwrapIIFE(code).changed).toBe(false);
  });

  it("is a no-op for a plain script", () => {
    const code = "const x = 1;";
    expect(unwrapIIFE(code).changed).toBe(false);
  });

  it("does not unwrap an IIFE with a defaulted parameter", () => {
    const code = "(async (x = 42) => { return x; })();";
    const result = unwrapIIFE(code);
    expect(result.changed).toBe(false);
    expect(result.code).toBe(code);
  });

  it("does not unwrap an IIFE with any parameter", () => {
    const code = "(async (x) => { return x; })();";
    expect(unwrapIIFE(code).changed).toBe(false);
  });

  it("does not unwrap a bare async arrow that takes parameters", () => {
    const code = "async (x) => { return x; }";
    expect(unwrapIIFE(code).changed).toBe(false);
  });

  it("does not unwrap a named async function expression with parameters", () => {
    const code = "(async function f(x) { return x; })();";
    expect(unwrapIIFE(code).changed).toBe(false);
  });
});
