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
});
