import { describe, expect, it } from "vitest";

import { stripCodeFences } from "./fences.ts";

describe("stripCodeFences", () => {
  it("unwraps a fenced block with a language tag", () => {
    const result = stripCodeFences("```js\nconst x = 1;\n```");
    expect(result.changed).toBe(true);
    expect(result.code).toBe("const x = 1;");
    expect(result.language).toBe("js");
  });

  it("unwraps a fence without a language tag", () => {
    expect(stripCodeFences("```\nconst x = 1;\n```").code).toBe("const x = 1;");
  });

  it("unwraps tilde fences", () => {
    expect(stripCodeFences("~~~javascript\nconst x = 1;\n~~~").code).toBe("const x = 1;");
  });

  it("extracts the only fenced block from surrounding prose", () => {
    const input = "Here is the script:\n\n```js\nawait tools.read({ path: \"a\" });\n```\n\nLet me know!";
    const result = stripCodeFences(input);
    expect(result.changed).toBe(true);
    expect(result.code).toBe('await tools.read({ path: "a" });');
  });

  it("does not extract a fence from surrounding code", () => {
    const input = "const tpl = 1;\n```js\nconst x = 1;\n```";
    const result = stripCodeFences(input);
    expect(result.changed).toBe(false);
    expect(result.code).toBe(input);
  });

  it("drops an unterminated opening fence", () => {
    const result = stripCodeFences("```js\nconst x = 1;");
    expect(result.changed).toBe(true);
    expect(result.code).toBe("const x = 1;");
  });

  it("leaves plain JavaScript alone", () => {
    const input = "const x = 1;\ntext(x);";
    const result = stripCodeFences(input);
    expect(result.changed).toBe(false);
    expect(result.code).toBe(input);
  });

  it("strips a fence at the input start that has trailing prose", () => {
    const input = "```js\nconst x = 1;\n```\nThanks!";
    const result = stripCodeFences(input);
    expect(result.changed).toBe(true);
    expect(result.code).toBe("const x = 1;");
    expect(result.language).toBe("js");
    expect(result.warnings).toEqual([]);
    // Idempotent: the stripped output is left alone.
    const again = stripCodeFences(result.code);
    expect(again.changed).toBe(false);
    expect(again.code).toBe(result.code);
  });

  it("strips nested fences to a fixed point in one pass", () => {
    const input = "```js\n```js\ninner\n```\n```";
    const once = stripCodeFences(input);
    expect(once.changed).toBe(true);
    expect(once.code).toBe("inner");
    expect(once.code).not.toContain("```");
    const twice = stripCodeFences(once.code);
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once.code);
  });

  it("strips an empty fenced block without leaking the marker", () => {
    const result = stripCodeFences("```js\n```");
    expect(result.changed).toBe(true);
    expect(result.code).toBe("");
    expect(result.code).not.toContain("```");
    const again = stripCodeFences(result.code);
    expect(again.changed).toBe(false);
  });

  it("does not drop marker-less code that precedes a fence", () => {
    const input = "console.log(1)\n```js\nreturn 2;\n```";
    const result = stripCodeFences(input);
    expect(result.changed).toBe(false);
    expect(result.code).toBe(input);
    expect(result.code).toContain("console.log(1)");
  });

  it("leaves a fence followed by more code alone instead of corrupting it", () => {
    const input = "```js\nconst a = 1;\n```\nconst b = 2;";
    const result = stripCodeFences(input);
    expect(result.changed).toBe(false);
    expect(result.code).toBe(input);
  });
});
