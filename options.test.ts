import { describe, expect, it } from "vitest";

import { splitOptionsLine } from "./options.ts";

describe("splitOptionsLine", () => {
  it("keeps a canonical line as the first line", () => {
    const result = splitOptionsLine('// @options: {"max_output_tokens": 2000}\nreturn 1;');
    expect(result.changed).toBe(true);
    expect(result.optionsLine).toBe('// @options: {"max_output_tokens": 2000}');
    expect(result.body).toBe("return 1;");
  });

  it("adds the missing colon", () => {
    const result = splitOptionsLine('// @options {"timeout_ms": 30000}\nreturn 1;');
    expect(result.optionsLine).toBe('// @options: {"timeout_ms": 30000}');
  });

  it("normalizes a block comment with single quotes and unquoted keys", () => {
    const result = splitOptionsLine("/* @options: {'maxOutputTokens': 2000} */\nreturn 1;");
    expect(result.optionsLine).toBe('// @options: {"max_output_tokens": 2000}');
    expect(result.body).toBe("return 1;");
  });

  it("maps field aliases", () => {
    const result = splitOptionsLine("// options: {maxOutputTokens: 1500, timeout: 45000}\nreturn 1;");
    expect(result.optionsLine).toBe('// @options: {"max_output_tokens": 1500, "timeout_ms": 45000}');
  });

  it("drops unsupported fields but keeps recognized ones", () => {
    const result = splitOptionsLine('// @options: {"yield": 1, "max_tokens": 100}\nreturn 1;');
    expect(result.optionsLine).toBe('// @options: {"max_output_tokens": 100}');
  });

  it("neutralizes an unparseable options line", () => {
    const result = splitOptionsLine("// @options: not json at all\nreturn 1;");
    expect(result.optionsLine).toBeUndefined();
    expect(result.changed).toBe(true);
    expect(result.body).not.toContain("@options: not json");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("does not treat an ordinary options comment as a directive", () => {
    const input = "// options are documented in the README\nreturn 1;";
    const result = splitOptionsLine(input);
    expect(result.changed).toBe(false);
    expect(result.body).toBe(input);
  });

  it("finds the directive after blank and comment lines", () => {
    const result = splitOptionsLine('\n// a note\n// @options: {"timeout_ms": 1000}\nreturn 1;');
    expect(result.optionsLine).toBe('// @options: {"timeout_ms": 1000}');
    expect(result.body).toContain("return 1;");
    expect(result.body).toContain("// a note");
  });

  it("ignores an options line that appears after code", () => {
    const input = 'const x = 1;\n// @options: {"timeout_ms": 1000}';
    const result = splitOptionsLine(input);
    expect(result.changed).toBe(false);
    expect(result.body).toBe(input);
  });
});
