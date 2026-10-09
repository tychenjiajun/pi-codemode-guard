import { describe, expect, it } from "vitest";

import { injectAwait } from "./await-inject.ts";

function inject(code: string): string {
  return injectAwait(code)?.code ?? code;
}

describe("injectAwait", () => {
  it("awaits an unawaited tool call assigned to a variable", () => {
    expect(inject('const file = tools.read({ path: "a" });')).toBe('const file = await tools.read({ path: "a" });');
  });

  it("awaits the async lookup helpers", () => {
    expect(inject('const hits = searchTools("feishu");')).toBe('const hits = await searchTools("feishu");');
    expect(inject('const tool = describeTool("read");')).toBe('const tool = await describeTool("read");');
    expect(inject('const ns = describeNamespace("mcp");')).toBe('const ns = await describeNamespace("mcp");');
  });

  it("awaits async models methods", () => {
    expect(inject('const m = models.getModelOfType("classifier", "p", "i");')).toBe(
      'const m = await models.getModelOfType("classifier", "p", "i");',
    );
    expect(inject("const r = models.classify(m, ctx);")).toBe("const r = await models.classify(m, ctx);");
  });

  it("leaves already-awaited calls alone", () => {
    const code = 'const file = await tools.read({ path: "a" });';
    expect(inject(code)).toBe(code);
  });

  it("leaves Promise.all members alone", () => {
    const code = 'const all = await Promise.all([tools.read({ path: "a" }), tools.bash({ command: "ls" })]);';
    expect(inject(code)).toBe(code);
    const allSettled = "const all = Promise.allSettled([searchTools('x'), describeTool('y')]);";
    expect(inject(allSettled)).toBe(allSettled);
  });

  it("leaves promise chains alone", () => {
    const code = 'tools.read({ path: "a" }).then((r) => text(r)).catch(() => {});';
    expect(inject(code)).toBe(code);
  });

  it("leaves calls inside a non-async function alone", () => {
    const code = 'const f = () => tools.read({ path: "a" });';
    expect(inject(code)).toBe(code);
  });

  it("awaits calls inside an async function", () => {
    expect(inject('const f = async () => tools.read({ path: "a" });')).toBe(
      'const f = async () => await tools.read({ path: "a" });',
    );
  });

  it("wraps calls that are immediately indexed or called", () => {
    expect(inject('tools.read({ path: "a" }).trim();')).toBe('(await tools.read({ path: "a" })).trim();');
    expect(inject('tools.read({ path: "a" })[0];')).toBe('(await tools.read({ path: "a" }))[0];');
  });

  it("keeps already-parenthesized awaits alone", () => {
    const code = '(await tools.read({ path: "a" })).trim();';
    expect(inject(code)).toBe(code);
  });

  it("awaits nested calls", () => {
    expect(inject('toolResult = tools.bash({ command: tools.read({ path: "a" }) });')).toBe(
      'toolResult = await tools.bash({ command: await tools.read({ path: "a" }) });',
    );
  });

  it("counts the inserted awaits", () => {
    const result = injectAwait('const a = tools.read({ path: "a" });\nconst b = searchTools("x");');
    expect(result?.inserted).toBe(2);
  });

  it("returns undefined when the script does not parse", () => {
    expect(injectAwait("const = ;")).toBeUndefined();
  });
});
