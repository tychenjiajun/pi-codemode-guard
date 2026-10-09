import { describe, expect, it } from "vitest";

import { CodemodeProgramError, looksLikeToolProgram, programToJs, toToolCall } from "./program.ts";

describe("toToolCall", () => {
  it("reads an explicit tool key with a separate args object", () => {
    expect(toToolCall({ tool: "read", args: { path: "a" } })).toEqual({ tool: "read", args: { path: "a" } });
  });

  it("accepts the common key aliases", () => {
    expect(toToolCall({ toolName: "bash", input: { command: "ls" } })).toEqual({
      tool: "bash",
      args: { command: "ls" },
    });
    expect(toToolCall({ tool_name: "grep", arguments: { pattern: "x" } })).toEqual({
      tool: "grep",
      args: { pattern: "x" },
    });
    expect(toToolCall({ name: "ls", params: { path: "." } })).toEqual({ tool: "ls", args: { path: "." } });
    expect(toToolCall({ function: "read", parameters: { path: "a" } })).toEqual({
      tool: "read",
      args: { path: "a" },
    });
  });

  it("collects inline arguments next to the tool key", () => {
    expect(toToolCall({ tool: "bash", command: "ls", timeout: 5 })).toEqual({
      tool: "bash",
      args: { command: "ls", timeout: 5 },
    });
  });

  it("supports the single-key shorthand", () => {
    expect(toToolCall({ read: { path: "a" } })).toEqual({ tool: "read", args: { path: "a" } });
  });

  it("parses a JSON string of arguments", () => {
    expect(toToolCall({ tool: "read", args: '{"path":"a"}' })).toEqual({ tool: "read", args: { path: "a" } });
  });

  it("rejects values that are not tool calls", () => {
    expect(toToolCall("read")).toBeUndefined();
    expect(toToolCall({ path: "a" })).toBeUndefined();
    expect(toToolCall({ a: 1, b: 2 })).toBeUndefined();
    expect(toToolCall(null)).toBeUndefined();
  });
});

describe("programToJs", () => {
  it("compiles a single tool call to an awaited call with a return", () => {
    expect(programToJs([{ tool: "read", args: { path: "a" } }])).toBe(
      'const _result0 = await tools.read({"path":"a"});\nreturn _result0;',
    );
  });

  it("compiles several tool calls and returns the collected results", () => {
    expect(
      programToJs([
        { tool: "read", args: { path: "a" } },
        { tool: "bash", args: { command: "ls" } },
      ]),
    ).toBe(
      'const _result0 = await tools.read({"path":"a"});\n' +
        'const _result1 = await tools.bash({"command":"ls"});\n' +
        "return [_result0, _result1];",
    );
  });

  it("converts tool names to codemode identifiers", () => {
    expect(programToJs([{ tool: "mcp__dev-radius__search", args: {} }])).toBe(
      'const _result0 = await tools.mcp__dev_radius__search({});\nreturn _result0;',
    );
  });

  it("passes raw JavaScript string steps through", () => {
    expect(programToJs(["const x = 1;", { tool: "read", args: { path: "a" } }])).toBe(
      'const x = 1;\nconst _result0 = await tools.read({"path":"a"});\nreturn _result0;',
    );
  });

  it("returns only the raw steps when there are no tool calls", () => {
    expect(programToJs(["const x = 1;", "text(x);"])).toBe("const x = 1;\ntext(x);");
  });

  it("throws on an unrecognized step", () => {
    expect(() => programToJs([{ notATool: 1, another: 2 }])).toThrow(CodemodeProgramError);
  });
});

describe("looksLikeToolProgram", () => {
  it("recognizes tool-call programs", () => {
    expect(looksLikeToolProgram([{ tool: "read", args: {} }])).toBe(true);
    expect(looksLikeToolProgram({ tool: "read", args: {} })).toBe(true);
    expect(looksLikeToolProgram(["const x = 1;"])).toBe(true);
  });

  it("rejects plain JSON and empty arrays", () => {
    expect(looksLikeToolProgram({ a: 1, b: 2 })).toBe(false);
    expect(looksLikeToolProgram([])).toBe(false);
  });
});
