import { describe, expect, it } from "vitest";

import { parseScript } from "./parse.ts";
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

  it("guesses a path argument key for read-like tools", () => {
    expect(toToolCall({ tool: "read", args: "package.json" })).toEqual({
      tool: "read",
      args: { path: "package.json" },
    });
    expect(toToolCall({ tool: "mcp__fs__read_file", args: "a.txt" })).toEqual({
      tool: "mcp__fs__read_file",
      args: { path: "a.txt" },
    });
  });

  it("guesses path vs content for write-like tools", () => {
    expect(toToolCall({ tool: "write", args: "/tmp/a.txt" })).toEqual({
      tool: "write",
      args: { path: "/tmp/a.txt" },
    });
    expect(toToolCall({ tool: "write", args: "hello\nworld" })).toEqual({
      tool: "write",
      args: { content: "hello\nworld" },
    });
  });

  it("keeps command as the fallback key for shell-like tools", () => {
    expect(toToolCall({ tool: "bash", args: "ls -la" })).toEqual({
      tool: "bash",
      args: { command: "ls -la" },
    });
  });

  it("serializes quotes, backslashes, and line separators safely", () => {
    const args = { command: 'echo "a" \\ b\nnext\u2028line\u2029end' };
    const code = programToJs([{ tool: "bash", args }]);
    expect(code).toContain('\\"a\\"');
    expect(code).toContain("\\\\ b");
    expect(code).toContain("\\u2028");
    expect(code).toContain("\\u2029");
    expect(code).not.toContain("\u2028");
    expect(code).not.toContain("\u2029");
    expect(parseScript(code)).toBeDefined();
    // Round-trips to the original value.
    const match = code.match(/await tools\.bash\((.*)\);/);
    expect(match?.[1]).toBeDefined();
    expect(JSON.parse(match![1]!)).toEqual(args);
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
