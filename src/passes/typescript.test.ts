import { describe, expect, it } from "vitest";

import { UNSUPPORTED_GLOBALS } from "../dialect/signals.ts";
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

  it("never emits unsupported-globals identifiers (require/Buffer/process/...) of its own", () => {
    // TanStack/Vercel/PTC fixtures are TypeScript; sucrase must only REMOVE
    // syntax. If the pass ever emitted a runtime-global name, the translator's
    // `runtime` rows would warn about compiler-generated code, not model code.
    const input = [
      "interface Opts { q: string }",
      "type R = { ok: boolean };",
      "const pick = (o: Opts): R => ({ ok: true });",
      "const n = 1 as const;",
      "const merged = { ...pick({ q: 'x' }) } satisfies R;",
      "return merged;",
    ].join("\n");
    const result = stripTypeScriptSyntax(input);
    expect(result.changed).toBe(true);
    for (const entry of UNSUPPORTED_GLOBALS) {
      expect(result.code).not.toMatch(new RegExp(`\\b${entry.name}\\b`));
    }
  });

  it("does not truncate a script that contains the wrapper end marker literally", () => {
    const input =
      "const o = { a: 1 };\n" +
      'const marker = "___PI_GUARD_TS_WRAPPER_END___";\n' +
      "const y: number = 2;\n" +
      "return marker + y;";
    const result = stripTypeScriptSyntax(input);
    expect(result.warnings).toEqual([]);
    expect(result.changed).toBe(true);
    expect(result.code).toContain("const o = { a: 1 };");
    expect(result.code).toContain("return marker + y;");
    expect(result.code).not.toContain(": number");
    expect(result.code).toContain('"___PI_GUARD_TS_WRAPPER_END___"');
    // Idempotent: the stripped output survives a second pass intact.
    const again = stripTypeScriptSyntax(result.code);
    expect(again.changed).toBe(false);
    expect(again.code).toBe(result.code);
  });

  it("does not truncate a script that contains the wrapper start marker literally", () => {
    const input =
      'const fn = "async function ___PI_GUARD_TS_WRAPPER_START___() {}";\n' +
      "const y: number = 2;\n" +
      "return y;";
    const result = stripTypeScriptSyntax(input);
    expect(result.warnings).toEqual([]);
    expect(result.code).toContain("return y;");
    expect(result.code).not.toContain(": number");
  });
});