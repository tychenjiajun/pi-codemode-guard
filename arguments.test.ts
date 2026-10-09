import { describe, expect, it } from "vitest";

import { CodemodeArgumentError, coerceCodemodeArguments, normalizeCodemodeArguments } from "./arguments.ts";

describe("coerceCodemodeArguments", () => {
  it("accepts a raw JavaScript string", () => {
    expect(coerceCodemodeArguments("await tools.read({ path: 'a' });")).toEqual({
      code: "await tools.read({ path: 'a' });",
      kind: "raw-string",
    });
  });

  it("accepts the canonical code field", () => {
    expect(coerceCodemodeArguments({ code: "return 1;" })).toEqual({
      code: "return 1;",
      kind: "code-field",
      field: "code",
    });
  });

  it("accepts the common code aliases", () => {
    expect(coerceCodemodeArguments({ script: "return 1;" }).kind).toBe("alias-field");
    expect(coerceCodemodeArguments({ source: "return 1;" }).code).toBe("return 1;");
    expect(coerceCodemodeArguments({ javascript: "return 1;" }).code).toBe("return 1;");
    expect(coerceCodemodeArguments({ input: "return 1;" }).code).toBe("return 1;");
  });

  it("unwraps a nested source object", () => {
    expect(coerceCodemodeArguments({ code: { language: "javascript", content: "return 1;" } })).toEqual({
      code: "return 1;",
      kind: "nested-code",
      field: "code",
    });
  });

  it("compiles an array of tool calls", () => {
    const result = coerceCodemodeArguments([{ tool: "read", args: { path: "a" } }]);
    expect(result.kind).toBe("step-array");
    expect(result.code).toContain('await tools.read({"path":"a"})');
  });

  it("compiles a tool-call program field", () => {
    const result = coerceCodemodeArguments({ tool_calls: [{ tool: "bash", args: { command: "ls" } }] });
    expect(result.kind).toBe("tool-program");
    expect(result.field).toBe("tool_calls");
    expect(result.code).toContain("await tools.bash");
  });

  it("compiles a single tool call object", () => {
    const result = coerceCodemodeArguments({ tool: "read", args: { path: "a" } });
    expect(result.kind).toBe("tool-call");
    expect(result.code).toContain("await tools.read");
  });

  it("falls back to an alias when code is present but unusable", () => {
    expect(coerceCodemodeArguments({ code: 42, script: "return 1;" })).toMatchObject({
      code: "return 1;",
      kind: "alias-field",
      field: "script",
    });
  });

  it("rejects unusable arguments", () => {
    expect(() => coerceCodemodeArguments({})).toThrow(CodemodeArgumentError);
    expect(() => coerceCodemodeArguments(null)).toThrow(CodemodeArgumentError);
    expect(() => coerceCodemodeArguments(42)).toThrow(CodemodeArgumentError);
    expect(() => coerceCodemodeArguments({ code: 42 })).toThrow(CodemodeArgumentError);
  });
});

describe("normalizeCodemodeArguments", () => {
  it("always returns the canonical shape pi validates", () => {
    expect(normalizeCodemodeArguments({ script: "return 1;" })).toEqual({ code: "return 1;" });
    expect(normalizeCodemodeArguments("return 1;")).toEqual({ code: "return 1;" });
  });
});
