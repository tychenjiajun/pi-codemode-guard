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

  it("passes prose that only looks like a bare options directive through untouched", () => {
    const input = "// options: use timeout: 30000\nreturn 1;";
    const result = splitOptionsLine(input);
    expect(result.changed).toBe(false);
    expect(result.optionsLine).toBeUndefined();
    expect(result.body).toBe(input);
    expect(result.warnings).toEqual([]);
  });

  it("passes `// options: see README` through untouched with no warning", () => {
    const input = "// options: see README\nreturn 1;";
    const result = splitOptionsLine(input);
    expect(result.changed).toBe(false);
    expect(result.body).toBe(input);
    expect(result.warnings).toEqual([]);
  });

  it("falls through to the next alias when a value is invalid", () => {
    const result = splitOptionsLine('// @options: {"max_output_tokens": "abc", "maxTokens": 500}\nreturn 1;');
    expect(result.optionsLine).toBe('// @options: {"max_output_tokens": 500}');
    expect(result.warnings).toEqual([]);
  });

  it("accepts max_output_tokens: 0 (pi allows a non-negative safe integer)", () => {
    const result = splitOptionsLine('// @options: {"max_output_tokens": 0}\nreturn 1;');
    expect(result.optionsLine).toBe('// @options: {"max_output_tokens": 0}');
    expect(result.warnings).toEqual([]);
  });

  it("is idempotent: re-splitting its own output is stable", () => {
    const once = splitOptionsLine("// options: {maxOutputTokens: 1500, timeout: 45000}\nreturn 1;");
    expect(once.optionsLine).toBeDefined();
    const rebuilt = `${once.optionsLine}\n${once.body}`;
    const twice = splitOptionsLine(rebuilt);
    expect(twice.optionsLine).toBe(once.optionsLine);
    expect(twice.body).toBe(once.body);
    // And prose stays prose.
    const prose = "// options: use timeout: 30000\nreturn 1;";
    const proseAgain = splitOptionsLine(splitOptionsLine(prose).body);
    expect(proseAgain.changed).toBe(false);
    expect(proseAgain.body).toBe(prose);
  });
});
