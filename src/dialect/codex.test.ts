import { describe, expect, it } from "vitest";

import { compileCodexDialect } from "./translate.ts";
import { compileCodemodeSource } from "../compile.ts";
import { parseScript } from "../core/parse.ts";

describe("compileCodexDialect", () => {
  it("reports Codex-only helpers and leaves the script alone", () => {
    const result = compileCodexDialect("yield_control();\nnotify(\"done\");\nsetTimeout(fn, 10);");
    expect(result.changed).toBe(false);
    expect(result.rewrites).toBe(0);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.some((warning) => warning.includes("yield_control"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("notify"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("setTimeout"))).toBe(true);
  });

  it("does not warn about the helpers Pi and Codex share", () => {
    const result = compileCodexDialect(
      'text("a");\nimage(block);\nstore("k", 1);\nload("k");\nexit();\nconst names = ALL_TOOLS.map((t) => t.name);',
    );
    expect(result.warnings).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it("does not warn about a locally bound helper", () => {
    const result = compileCodexDialect("const notify = (value) => value;\nnotify(1);");
    expect(result.warnings).toEqual([]);
  });

  it("is idempotent", () => {
    const once = compileCodexDialect("yield_control();");
    const twice = compileCodexDialect(once.code);
    expect(twice.code).toBe(once.code);
  });
});

describe("compileCodemodeSource: codex pragma", () => {
  it("maps `@exec` to `@options` and drops `yield_time_ms`", () => {
    const result = compileCodemodeSource(
      '// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}\nconst r = await tools.read({ path: "a" });',
    );
    expect(result.dialect).toBe("codex");
    expect(result.code).toBe('// @options: {"max_output_tokens": 1000}\nconst r = await tools.read({ path: "a" });');
    expect(result.warnings).toContain(
      "dropped `yield_time_ms` from the @exec pragma; Pi streams output when the script ends",
    );
    expect(result.passes).toContain("normalize-options-line");
  });

  it("neutralizes an `@exec` line with no Pi-recognized field", () => {
    const result = compileCodemodeSource('// @exec: {"yield_time_ms": 10000}\nreturn 1;');
    expect(result.dialect).toBe("codex");
    expect(result.code).toContain("// pi-codemode-guard: ignored an unparseable @exec line");
    expect(result.warnings.some((warning) => warning.includes("yield_time_ms"))).toBe(true);
  });

  it("compiles a Codex script with its Pi-compatible helpers", () => {
    const result = compileCodemodeSource(
      [
        "const file = await tools.read({ path: \"package.json\" });",
        "text(file);",
        'const hits = searchTools("pi");',
        "return hits;",
      ].join("\n"),
    );
    expect(result.dialect).toBe("pi");
    expect(result.code).toContain("const hits = await searchTools(\"pi\");");
    expect(parseScript(result.code)).toBeDefined();
  });
});
