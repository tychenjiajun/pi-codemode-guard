import { describe, expect, it } from "vitest";

import { detectCodemodeDialect } from "./dialect.ts";
import { compileTanstackDialect } from "./tanstack.ts";

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

describe("compileTanstackDialect", () => {
  it("maps an external binding to a Pi tool", () => {
    const result = compileTanstackDialect('await external_getWeather({ location: "London" });', {
      tools: ["getWeather"],
    });
    expect(result.changed).toBe(true);
    expect(result.rewrites).toBe(1);
    expect(result.code).toBe('await tools.getWeather({ location: "London" });');
  });

  it("strips the prefix without a catalog", () => {
    const result = compileTanstackDialect("await external_lookupOrder({ id: 1 });", { tools: [] });
    expect(result.code).toBe("await tools.lookupOrder({ id: 1 });");
  });

  it("resolves a binding through the catalog to Pi's identifier rule", () => {
    const result = compileTanstackDialect("await external_my_tool({});", { tools: ["my-tool"] });
    expect(result.code).toBe("await tools.my_tool({});");
  });

  it("leaves a locally bound external_* identifier alone", () => {
    const code = "const external_helper = () => 1;\nreturn external_helper();";
    expect(compileTanstackDialect(code, { tools: [] }).changed).toBe(false);
  });

  it("warns about an unresolved binding when a catalog is present", () => {
    const result = compileTanstackDialect("await external_missing({});", { tools: ["bash"] });
    expect(result.changed).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("returns unchanged for unparseable source", () => {
    expect(compileTanstackDialect("const = ;", { tools: [] }).changed).toBe(false);
  });

  it("is idempotent", () => {
    const once = compileTanstackDialect("await external_getWeather({});", { tools: ["getWeather"] });
    const twice = compileTanstackDialect(once.code, { tools: ["getWeather"] });
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });
});