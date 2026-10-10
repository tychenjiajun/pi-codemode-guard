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

  it("leaves a class field initializer alone (await is illegal there)", () => {
    const code = 'class A { p = tools.read({ path: "a" }); }';
    expect(inject(code)).toBe(code);
  });

  it("leaves a class static block alone (await is illegal there)", () => {
    const code = 'class A { static { tools.read({ path: "a" }); } }';
    expect(inject(code)).toBe(code);
  });

  it("leaves a class heritage expression alone (await is illegal there)", () => {
    const code = "class A extends tools.getBase({}) {}";
    expect(inject(code)).toBe(code);
  });

  it("parenthesizes await used as the base of **", () => {
    expect(inject("const n = tools.score({}) ** 2;")).toBe("const n = (await tools.score({})) ** 2;");
  });

  it("still awaits calls inside an async class method", () => {
    expect(inject('class A { async m() { const r = tools.read({ path: "a" }); } }')).toBe(
      'class A { async m() { const r = await tools.read({ path: "a" }); } }',
    );
  });

  it("does not await a locally bound tools object", () => {
    const code = "const tools = { read: () => 1 }; const x = tools.read();";
    expect(inject(code)).toBe(code);
  });

  it("does not await a locally declared searchTools", () => {
    const code = 'function searchTools(q) { return q; }\nconst hits = searchTools("x");';
    expect(inject(code)).toBe(code);
  });

  it("is idempotent", () => {
    const once = inject('const a = tools.read({ path: "a" });\ntools.bash({ command: "ls" }).trim();');
    const twice = inject(once);
    expect(twice).toBe(once);
    expect(injectAwait(once)?.inserted).toBe(0);
  });
});
