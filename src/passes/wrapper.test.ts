import { describe, expect, it } from "vitest";

import { renameWrapperParams } from "./wrapper.ts";

function rename(code: string): string {
  return renameWrapperParams(code)?.code ?? code;
}

/**
 * Run the script the way pi's sandbox does — as the body of
 * `(async (tools, console) => { … })` — in V8. V8 rejects the same
 * colliding declarations QuickJS does ("Identifier 'tools' has already been
 * declared"), so this is a faithful oracle for the collision: a collision
 * throws synchronously while the wrapper is being parsed.
 */
function runInWrapper(code: string): Promise<unknown> {
  const build = new Function(
    "searchTools",
    `return (async (tools, console) => {\n${code}\n})({ read: () => "tool" }, { log: () => {} });`,
  );
  return build(async () => []) as Promise<unknown>;
}

describe("renameWrapperParams", () => {
  it("renames the real-session bug: a top-level const tools", async () => {
    const code = 'const tools = await searchTools("wiki", { limit: 30 });\nconsole.log(JSON.stringify(tools, null, 2));';
    const result = renameWrapperParams(code);
    expect(result?.renamed).toBe(1);
    expect(result?.code).toBe(
      'const tools_ = await searchTools("wiki", { limit: 30 });\nconsole.log(JSON.stringify(tools_, null, 2));',
    );
    // The wrapper's own `console` stays untouched.
    expect(result?.code).toContain("console.log(");
    // The renamed script now runs where the original was a SyntaxError.
    expect(() => runInWrapper(code)).toThrow();
    await runInWrapper(result!.code); // resolves without a runtime error
  });

  it("renames let, class and destructuring declarations", () => {
    expect(rename("let tools = 1;\ntext(String(tools));")).toBe("let tools_ = 1;\ntext(String(tools_));");
    expect(rename("class tools {}\ntext(String(typeof tools));")).toBe(
      "class tools_ {}\ntext(String(typeof tools_));",
    );
    expect(rename("const { tools } = o;")).toBe("const { tools: tools_ } = o;");
    expect(rename("const [tools] = o;")).toBe("const [tools_] = o;");
    expect(rename("const { a, tools = fallback } = o;\ntext(String(tools));")).toBe(
      "const { a, tools: tools_ = fallback } = o;\ntext(String(tools_));",
    );
  });

  it("renames let console", () => {
    expect(rename("let console = 1;\ntext(String(console));")).toBe("let console_ = 1;\ntext(String(console_));");
  });

  it("leaves var and function declarations alone (var-scoped, legal next to a parameter)", () => {
    const varCode = "var tools = 1;\ntext(String(tools));";
    expect(rename(varCode)).toBe(varCode);
    const fnCode = "function tools() { return 1; }\ntext(String(tools()));";
    expect(rename(fnCode)).toBe(fnCode);
    const varConsole = "var console = 1;";
    expect(rename(varConsole)).toBe(varConsole);
  });

  it("leaves nested-scope declarations alone (they shadow the parameter legally)", () => {
    const forOf = "for (const tools of [1]) { text(String(tools)); }";
    expect(rename(forOf)).toBe(forOf);
    const block = "{ let tools = 2; text(String(tools)); }";
    expect(rename(block)).toBe(block);
    const iife = "(async () => { const tools = 1; return tools; })();";
    expect(rename(iife)).toBe(iife);
  });

  it("renames references in nested functions that resolve to the top-level binding", () => {
    const code = "const tools = 1;\nfunction f() { return tools; }\nconst g = () => tools + 1;";
    expect(rename(code)).toBe("const tools_ = 1;\nfunction f() { return tools_; }\nconst g = () => tools_ + 1;");
  });

  it("leaves a class static block's own binding alone", () => {
    // A static block is its own var/lexical scope (supported by pi's QuickJS),
    // so its `tools` shadows the wrapper parameter — and the script's top-level
    // `tools` — legally. Capturing it would silently change the output.
    expect(rename("const tools = 1;\nclass A { static { const tools = 2; text(String(tools)); } }")).toBe(
      "const tools_ = 1;\nclass A { static { const tools = 2; text(String(tools)); } }",
    );
    expect(rename("const tools = 1;\nclass A { static { var tools = 2; text(String(tools)); } }")).toBe(
      "const tools_ = 1;\nclass A { static { var tools = 2; text(String(tools)); } }",
    );
    // A static block that does *not* bind the name still references the
    // top-level binding, so that reference is renamed.
    expect(rename("const tools = 1;\nclass A { static { text(String(tools)); } }")).toBe(
      "const tools_ = 1;\nclass A { static { text(String(tools_)); } }",
    );
  });

  it("leaves references that resolve to a shadowing binding alone", () => {
    // The top-level const still collides and is renamed; the arrow's own
    // `tools` parameter — and its references — are a different binding.
    const param = "const tools = 1;\nconst f = (tools) => tools.x;\ntext(String(f));";
    expect(rename(param)).toBe("const tools_ = 1;\nconst f = (tools) => tools.x;\ntext(String(f));");
    const block = "const tools = 1;\n{ let tools = 2; text(String(tools)); }\ntext(String(tools));";
    expect(rename(block)).toBe(
      "const tools_ = 1;\n{ let tools = 2; text(String(tools)); }\ntext(String(tools_));",
    );
  });

  it("keeps object property names and renames shorthand values", () => {
    expect(rename("const tools = { a: 1 };\ntext(String(tools.a));")).toBe(
      "const tools_ = { a: 1 };\ntext(String(tools_.a));",
    );
    expect(rename("const tools = 1;\nconst o = { tools, x: tools };")).toBe(
      "const tools_ = 1;\nconst o = { tools: tools_, x: tools_ };",
    );
    expect(rename("const tools = 1;\nconst o = { [tools]: 2 };")).toBe("const tools_ = 1;\nconst o = { [tools_]: 2 };");
  });

  it("picks a fresh name that appears nowhere in the script", () => {
    expect(rename("const tools = 1;\nconst tools_ = 2;\ntext(String(tools + tools_));")).toBe(
      "const tools__ = 1;\nconst tools_ = 2;\ntext(String(tools__ + tools_));",
    );
  });

  it("renames both colliding parameters at once", () => {
    const result = renameWrapperParams("const tools = 1;\nlet console = tools;");
    expect(result?.renamed).toBe(2);
    expect(result?.code).toBe("const tools_ = 1;\nlet console_ = tools_;");
  });

  it("is idempotent and leaves everything else unchanged", () => {
    const once = renameWrapperParams('const tools = await searchTools("wiki");\ntext(JSON.stringify(tools));');
    expect(once).toBeDefined();
    const twice = renameWrapperParams(once!.code);
    expect(twice?.code).toBe(once!.code);
    expect(twice?.renamed).toBe(0);

    const plain = "text(await tools.read({ path: \"a\" }));";
    expect(renameWrapperParams(plain)).toEqual({ code: plain, renamed: 0 });
  });

  it("returns undefined for an unparseable script", () => {
    expect(renameWrapperParams("const = ;")).toBeUndefined();
  });
});
