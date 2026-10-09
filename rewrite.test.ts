import { describe, expect, it } from "vitest";

import { rewriteToolIdentifiers } from "./rewrite.ts";

describe("rewriteToolIdentifiers", () => {
  it("rewrites bracket access to pi's identifier", () => {
    const result = rewriteToolIdentifiers('tools["mcp__dev-radius__search"]({ query: "x" });');
    expect(result?.code).toBe('tools.mcp__dev_radius__search({ query: "x" });');
    expect(result?.changed).toBe(true);
  });

  it("rewrites a valid identifier bracket access to dot access", () => {
    expect(rewriteToolIdentifiers('tools["read"]({ path: "a" });')?.code).toBe('tools.read({ path: "a" });');
  });

  it("rewrites models members too", () => {
    expect(rewriteToolIdentifiers('models["getModelsOfType"]("classifier");')?.code).toBe(
      'models.getModelsOfType("classifier");',
    );
  });

  it("does not touch unrelated bracket access", () => {
    const code = 'obj.tools["x"]; const m = { tools: 1 }; m.tools["y"];';
    expect(rewriteToolIdentifiers(code)?.changed).toBe(false);
  });

  it("does not touch dynamic bracket access", () => {
    const code = "tools[name]({});";
    expect(rewriteToolIdentifiers(code)?.changed).toBe(false);
  });

  it("returns undefined when the script does not parse", () => {
    expect(rewriteToolIdentifiers("const = ;")).toBeUndefined();
  });
});
