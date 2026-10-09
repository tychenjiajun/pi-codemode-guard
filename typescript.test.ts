import { describe, expect, it } from "vitest";

import { stripTypeScriptSyntax } from "./typescript.ts";

describe("stripTypeScriptSyntax", () => {
  it("removes type annotations, generics, and assertions", () => {
    const result = stripTypeScriptSyntax(
      'const cities: Array<string> = ["Tokyo"];\nconst w = cities[0] as string;\nreturn w;',
    );
    expect(result.changed).toBe(true);
    expect(result.code).not.toContain("Array<string>");
    expect(result.code).not.toContain(" as string");
    expect(result.code).toContain('const cities = ["Tokyo"]');
    expect(result.code).toContain("cities[0]");
  });

  it("drops interface and type declarations", () => {
    const result = stripTypeScriptSyntax("interface Foo { a: string }\ntype B = number;\nconst b: B = 1;\nreturn b;");
    expect(result.changed).toBe(true);
    expect(result.code).not.toContain("interface Foo");
    expect(result.code).not.toContain("type B");
    expect(result.code).toContain("const b = 1");
    expect(result.code).toContain("return b;");
  });

  it("leaves plain JavaScript unchanged", () => {
    const code = 'const x = 1;\nawait external_getWeather({ location: "London" });';
    expect(stripTypeScriptSyntax(code)).toEqual({ code, changed: false, warnings: [] });
  });

  it("is idempotent", () => {
    const once = stripTypeScriptSyntax("const x: number = 1;\nreturn x;");
    const twice = stripTypeScriptSyntax(once.code);
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });

  it("returns the input unchanged with a warning on unparseable TypeScript", () => {
    const result = stripTypeScriptSyntax("const = ;");
    expect(result.changed).toBe(false);
    expect(result.code).toBe("const = ;");
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});