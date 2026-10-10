import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { PI_CODEMODE_GUARD_DETAILS_KEY, readPiCodemodeGuardDetails } from "./contract.ts";
import codemodeGuardExtension, { augmentCodemodeTool } from "./index.ts";

// Delegates to the real compiler by default; throws only when the flag is set,
// so the compile-throws fallback below can be exercised without changing the
// behavior of every other test in this file.
const compileMock = vi.hoisted(() => ({ shouldThrow: false }));

vi.mock("./compile.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./compile.ts")>();
  return {
    ...actual,
    compileCodemodeSource: (...args: Parameters<typeof actual.compileCodemodeSource>) => {
      if (compileMock.shouldThrow) throw new Error("compile exploded");
      return actual.compileCodemodeSource(...args);
    },
  };
});

const emptyObjectSchema = { type: "object", properties: {} } as unknown as ToolDefinition["parameters"];
const codeSchema = {
  type: "object",
  properties: { code: { type: "string" } },
  required: ["code"],
} as unknown as ToolDefinition["parameters"];

type Handler = (...args: unknown[]) => unknown;

interface MockPi {
  readonly pi: ExtensionAPI;
  readonly registered: ToolDefinition[];
  readonly handlers: Map<string, Handler[]>;
}

function mockPi(): MockPi {
  const registered: ToolDefinition[] = [];
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      registered.push(tool);
    },
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    getAllTools() {
      return [{ name: "orders.lookup" }, { name: "mcp__dev-radius__search" }, { name: "bash" }];
    },
  } as unknown as ExtensionAPI;
  return { pi, registered, handlers };
}

function mockContext(): ExtensionContext {
  return {
    hasUI: false,
    mode: "print",
    ui: { notify: () => {}, setStatus: () => {} },
  } as unknown as ExtensionContext;
}

function firstHandler(mock: MockPi, event: string): Handler {
  const handler = mock.handlers.get(event)?.[0];
  if (!handler) throw new Error(`no handler for ${event}`);
  return handler;
}

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const GUARD_RECORD = {
  version: 1,
  originalCode: '```js\nreturn 1;\n```',
  compiledCode: "return 1;",
  passes: ["strip-code-fence"],
  parsed: true,
  dialect: "pi",
  warnings: [],
};

function makeComponent(): { children: unknown[]; addChild?: (child: unknown) => void } {
  const children: unknown[] = [];
  return {
    children,
    addChild: (child: unknown) => {
      children.push(child);
    },
  };
}

function renderWith(
  tool: ToolDefinition,
  result: unknown,
  isPartial = false,
): ReturnType<NonNullable<ToolDefinition["renderResult"]>> {
  const renderer = tool.renderResult;
  if (!renderer) throw new Error("no renderResult");
  return renderer(
    result as Parameters<typeof renderer>[0],
    { isPartial } as unknown as Parameters<typeof renderer>[1],
    fakeTheme,
    {} as unknown as Parameters<typeof renderer>[3],
  );
}

function toolResultEvent(toolCallId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "tool_result",
    toolName: "codemode",
    toolCallId,
    input: {},
    content: [],
    isError: false,
    details: {},
    ...extra,
  };
}

function guardRenderTool(
  renderResult: NonNullable<ToolDefinition["renderResult"]>,
): ToolDefinition {
  return augmentCodemodeTool({
    name: "codemode",
    label: "codemode",
    description: "codemode",
    parameters: codeSchema,
    execute: async () => ({ content: [], details: undefined }),
    renderResult,
  });
}

const passthroughTool = (): ToolDefinition => ({
  name: "read",
  label: "read",
  description: "read",
  parameters: emptyObjectSchema,
  execute: async () => ({ content: [], details: undefined }),
});

describe("augmentCodemodeTool", () => {
  it("adds a prepareArguments shim to the codemode tool", () => {
    const tool = augmentCodemodeTool({
      name: "codemode",
      label: "codemode",
      description: "codemode",
      parameters: codeSchema,
      execute: async () => ({ content: [], details: undefined }),
    });
    expect(typeof tool.prepareArguments).toBe("function");
    expect(tool.prepareArguments?.({ script: "return 1;" })).toEqual({ code: "return 1;" });
    expect(tool.prepareArguments?.("return 1;")).toEqual({ code: "return 1;" });
  });

  it("leaves other tools untouched", () => {
    const tool = passthroughTool();
    expect(augmentCodemodeTool(tool)).toBe(tool);
  });

  it("applies the compile receipt when details carry the guard record", () => {
    const component = makeComponent();
    const tool = guardRenderTool(() => component as never);

    const rendered = renderWith(tool, { details: { [PI_CODEMODE_GUARD_DETAILS_KEY]: GUARD_RECORD } });

    expect(component.children).toHaveLength(1);
    expect(rendered).toBe(component);
  });

  it("skips the receipt for partial results", () => {
    const component = makeComponent();
    const tool = guardRenderTool(() => component as never);

    renderWith(tool, { details: { [PI_CODEMODE_GUARD_DETAILS_KEY]: GUARD_RECORD } }, true);

    expect(component.children).toHaveLength(0);
  });

  it("skips the receipt when details carry no guard record or an unknown version", () => {
    const bare = makeComponent();
    const tool = guardRenderTool(() => bare as never);

    renderWith(tool, {});
    renderWith(tool, { details: {} });
    renderWith(tool, { details: { [PI_CODEMODE_GUARD_DETAILS_KEY]: { ...GUARD_RECORD, version: 99 } } });

    expect(bare.children).toHaveLength(0);
  });

  it("does not throw when the original renderer returns a component without addChild", () => {
    const bare: { addChild?: (child: unknown) => void } = {};
    const tool = guardRenderTool(() => bare as never);

    expect(() => renderWith(tool, { details: { [PI_CODEMODE_GUARD_DETAILS_KEY]: GUARD_RECORD } })).not.toThrow();
    expect(renderWith(tool, { details: { [PI_CODEMODE_GUARD_DETAILS_KEY]: GUARD_RECORD } })).toBe(bare);
  });

  it("adds exactly one receipt per render (repeated renders do not accumulate)", () => {
    const tool = guardRenderTool(() => makeComponent() as never);

    const first = renderWith(tool, { details: { [PI_CODEMODE_GUARD_DETAILS_KEY]: GUARD_RECORD } }) as {
      children?: unknown[];
    };
    const second = renderWith(tool, { details: { [PI_CODEMODE_GUARD_DETAILS_KEY]: GUARD_RECORD } }) as {
      children?: unknown[];
    };

    expect(first.children).toHaveLength(1);
    expect(second.children).toHaveLength(1);
  });
});

describe("codemodeGuardExtension", () => {
  it("registers the guarded codemode tool and the guard handlers", () => {
    const mock = mockPi();
    codemodeGuardExtension(mock.pi);

    expect(mock.registered).toHaveLength(1);
    const tool = mock.registered[0]!;
    expect(tool.name).toBe("codemode");
    expect(typeof tool.prepareArguments).toBe("function");
    expect(mock.handlers.has("tool_call")).toBe(true);
    expect(mock.handlers.has("tool_result")).toBe(true);
  });

  it("compiles a codemode call and stamps the guard details", async () => {
    const mock = mockPi();
    codemodeGuardExtension(mock.pi);
    const ctx = mockContext();

    const event: Record<string, unknown> = {
      type: "tool_call",
      toolName: "codemode",
      toolCallId: "c1",
      input: { code: '```js\nconst f = tools.read({ path: "a" });\n```' },
    };
    await firstHandler(mock, "tool_call")(event, ctx);
    expect(event.input).toMatchObject({ code: expect.stringContaining("await tools.read") });

    const result = (await firstHandler(mock, "tool_result")(
      {
        type: "tool_result",
        toolName: "codemode",
        toolCallId: "c1",
        input: {},
        content: [],
        isError: false,
        details: { calls: [] },
      },
      ctx,
    )) as { details?: unknown };

    const guard = readPiCodemodeGuardDetails(result.details);
    expect(guard).toBeDefined();
    expect(guard?.passes).toContain("strip-code-fence");
    expect(guard?.originalCode).toContain("```js");
    expect(guard?.compiledCode).toContain("await tools.read");
  });

  it("ignores other tools", async () => {
    const mock = mockPi();
    codemodeGuardExtension(mock.pi);
    const ctx = mockContext();

    const event: Record<string, unknown> = {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "b1",
      input: { command: "ls" },
    };
    await firstHandler(mock, "tool_call")(event, ctx);
    expect(event.input).toEqual({ command: "ls" });
  });

  it("compiles an OpenCode-dialect call to Pi syntax", async () => {
    const mock = mockPi();
    codemodeGuardExtension(mock.pi);
    const ctx = mockContext();

    const event: Record<string, unknown> = {
      type: "tool_call",
      toolName: "codemode",
      toolCallId: "oc1",
      input: {
        code: 'const o = await tools.orders.lookup({ id: "1" });\nconst p = await tools.$codemode.search({ query: "x" });\nreturn o;',
      },
    };
    await firstHandler(mock, "tool_call")(event, ctx);
    const code = (event.input as { code: string }).code;
    expect(code).toContain("tools.orders_lookup");
    expect(code).toContain("searchTools(__cm_query");

    const result = (await firstHandler(mock, "tool_result")(
      {
        type: "tool_result",
        toolName: "codemode",
        toolCallId: "oc1",
        input: {},
        content: [],
        isError: false,
        details: {},
      },
      ctx,
    )) as { details?: unknown };

    expect(readPiCodemodeGuardDetails(result.details)?.dialect).toBe("opencode");
  });

  it("compiles a Cloudflare-dialect call to Pi syntax", async () => {
    const mock = mockPi();
    codemodeGuardExtension(mock.pi);
    const ctx = mockContext();

    const event: Record<string, unknown> = {
      type: "tool_call",
      toolName: "codemode",
      toolCallId: "cf1",
      input: {
        code: 'async () => {\n  const o = await codemode.lookupOrder({ id: "1" });\n  return o;\n}',
      },
    };
    await firstHandler(mock, "tool_call")(event, ctx);
    const code = (event.input as { code: string }).code;
    expect(code).toContain("tools.lookupOrder");
    expect(code).not.toContain("codemode.");

    const result = (await firstHandler(mock, "tool_result")(
      {
        type: "tool_result",
        toolName: "codemode",
        toolCallId: "cf1",
        input: {},
        content: [],
        isError: false,
        details: {},
      },
      ctx,
    )) as { details?: unknown };

    expect(readPiCodemodeGuardDetails(result.details)?.dialect).toBe("cloudflare");
  });

  it("compiles a TanStack-dialect call through the extension", async () => {
    const mock = mockPi();
    codemodeGuardExtension(mock.pi);
    const registered = mock.registered[0]!; // the augmentCodemodeTool'd codemode tool
    const ctx = mockContext();
    const event: Record<string, unknown> = {
      type: "tool_call",
      toolName: "codemode",
      toolCallId: "ts1",
      input: {
        typescriptCode:
          'const city: string = "London";\nconst w = external_bash({ command: "echo" + city });\ntext(w);',
      },
    };
    // Mimic pi running the prepareArguments shim before validation.
    event.input = registered.prepareArguments!(event.input as unknown);
    await firstHandler(mock, "tool_call")(event, ctx);
    const code = (event.input as { code: string }).code;
    expect(code).not.toContain("external_");
    expect(code).not.toContain(": string");
    expect(code).toContain("tools.bash({ command");

    const result = (await firstHandler(mock, "tool_result")(
      {
        type: "tool_result",
        toolName: "codemode",
        toolCallId: "ts1",
        input: {},
        content: [],
        isError: false,
        details: {},
      },
      ctx,
    )) as { details?: unknown };
    const guard = readPiCodemodeGuardDetails(result.details);
    expect(guard?.dialect).toBe("tanstack");
    expect(guard?.passes).toContain("tanstack-typescript");
    expect(guard?.passes).toContain("tanstack-dialect(1)");
    expect(guard?.passes).toContain("await-async-calls(1)");
  });

  it("compiles a PTC-dialect call through the extension", async () => {
    const mock = mockPi();
    codemodeGuardExtension(mock.pi);
    const notifications: string[] = [];
    const ctx = {
      hasUI: true,
      mode: "print",
      ui: { notify: (message: string) => notifications.push(message), setStatus: () => {} },
    } as unknown as ExtensionContext;
    const event: Record<string, unknown> = {
      type: "tool_call",
      toolName: "codemode",
      toolCallId: "ptc1",
      input: {
        code: [
          "interface Weather { temp: number }",
          "const names = Object.keys(tools);",
          'const w: Weather = await tools["get-weather"]({ location: "London" });',
          "return { names, w };",
        ].join("\n"),
      },
    };
    await firstHandler(mock, "tool_call")(event, ctx);
    const code = (event.input as { code: string }).code;
    expect(code).toContain("await tools.get_weather");
    expect(code).toContain("ALL_TOOLS.map((__ptc_tool) => __ptc_tool.name)");
    expect(code).not.toContain("interface");

    const result = (await firstHandler(mock, "tool_result")(
      {
        type: "tool_result",
        toolName: "codemode",
        toolCallId: "ptc1",
        input: {},
        content: [],
        isError: false,
        details: {},
      },
      ctx,
    )) as { details?: unknown };
    const guard = readPiCodemodeGuardDetails(result.details);
    expect(guard?.dialect).toBe("ptc");
    expect(guard?.passes).toContain("ptc-typescript");
    expect(guard?.passes).toContain("ptc-dialect(2)");
    expect(notifications.some((message) => message.includes("ptc → pi"))).toBe(true);
  });

  it("stamps a warning-only Cloudflare result", async () => {
    const mock = mockPi();
    codemodeGuardExtension(mock.pi);
    const ctx = mockContext();

    await firstHandler(mock, "tool_call")(
      {
        type: "tool_call",
        toolName: "codemode",
        toolCallId: "cf2",
        input: { code: 'await codemode.run("saved");' },
      },
      ctx,
    );
    const result = (await firstHandler(mock, "tool_result")(
      {
        type: "tool_result",
        toolName: "codemode",
        toolCallId: "cf2",
        input: {},
        content: [],
        isError: false,
        details: {},
      },
      ctx,
    )) as { details?: unknown };

    const guard = readPiCodemodeGuardDetails(result.details);
    expect(guard?.dialect).toBe("cloudflare");
    expect(guard?.warnings.some((warning) => warning.includes("codemode.run"))).toBe(true);
  });

  it("does not stamp details when no compilation happened", async () => {
    const mock = mockPi();
    codemodeGuardExtension(mock.pi);
    const ctx = mockContext();

    await firstHandler(mock, "tool_call")(
      {
        type: "tool_call",
        toolName: "codemode",
        toolCallId: "c2",
        input: { code: 'const f = await tools.read({ path: "a" });' },
      },
      ctx,
    );
    const result = await firstHandler(mock, "tool_result")(
      { type: "tool_result", toolName: "codemode", toolCallId: "c2", input: {}, content: [], isError: false, details: {} },
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it("still compiles and stamps when the UI notification throws", async () => {
    const mock = mockPi();
    codemodeGuardExtension(mock.pi);
    const ctx = {
      hasUI: true,
      mode: "print",
      ui: {
        notify: () => {
          throw new Error("ui down");
        },
        setStatus: () => {
          throw new Error("ui down");
        },
      },
    } as unknown as ExtensionContext;

    const event: Record<string, unknown> = {
      type: "tool_call",
      toolName: "codemode",
      toolCallId: "ui1",
      input: { code: '```js\nreturn 1;\n```' },
    };
    // A UI failure must not reject the tool_call handler.
    await firstHandler(mock, "tool_call")(event, ctx);
    expect(event.input).toMatchObject({ code: "return 1;" });

    const result = (await firstHandler(mock, "tool_result")(toolResultEvent("ui1"), ctx)) as {
      details?: unknown;
    };
    expect(readPiCodemodeGuardDetails(result.details)?.originalCode).toContain("```js");
  });

  it("keeps pending records bounded when results never arrive", async () => {
    const mock = mockPi();
    codemodeGuardExtension(mock.pi);
    const ctx = mockContext();
    const callTool = (toolCallId: string) =>
      firstHandler(mock, "tool_call")(
        {
          type: "tool_call",
          toolName: "codemode",
          toolCallId,
          input: { code: '```js\nreturn 1;\n```' },
        },
        ctx,
      );
    const resultFor = async (toolCallId: string) =>
      (await firstHandler(mock, "tool_result")(toolResultEvent(toolCallId), ctx)) as
        | { details?: unknown }
        | undefined;

    // 40 abandoned calls (no tool_result) with a FIFO cap of 32: leak0..leak7
    // are evicted, leak8..leak39 are kept.
    for (let i = 0; i < 40; i += 1) await callTool(`leak${i}`);

    expect(await resultFor("leak0")).toBeUndefined();
    expect(await resultFor("leak7")).toBeUndefined();
    expect(readPiCodemodeGuardDetails((await resultFor("leak8"))?.details)).toBeDefined();
    expect(readPiCodemodeGuardDetails((await resultFor("leak39"))?.details)).toBeDefined();
  });

  it("stamps the guard record on error results too", async () => {
    const mock = mockPi();
    codemodeGuardExtension(mock.pi);
    const ctx = mockContext();

    await firstHandler(mock, "tool_call")(
      {
        type: "tool_call",
        toolName: "codemode",
        toolCallId: "err1",
        input: { code: '```js\nreturn 1;\n```' },
      },
      ctx,
    );
    const result = (await firstHandler(mock, "tool_result")(
      toolResultEvent("err1", { isError: true, details: { error: "boom" } }),
      ctx,
    )) as { details?: unknown };

    const guard = readPiCodemodeGuardDetails(result.details);
    expect(guard?.originalCode).toContain("```js");
    expect(result.details).toMatchObject({ error: "boom" });
  });

  it("keeps two interleaved codemode calls independent", async () => {
    const mock = mockPi();
    codemodeGuardExtension(mock.pi);
    const ctx = mockContext();

    await firstHandler(mock, "tool_call")(
      {
        type: "tool_call",
        toolName: "codemode",
        toolCallId: "p1",
        input: { code: '```js\nreturn "one";\n```' },
      },
      ctx,
    );
    await firstHandler(mock, "tool_call")(
      {
        type: "tool_call",
        toolName: "codemode",
        toolCallId: "p2",
        input: { code: '```js\nreturn "two";\n```' },
      },
      ctx,
    );

    const first = (await firstHandler(mock, "tool_result")(toolResultEvent("p1"), ctx)) as {
      details?: unknown;
    };
    const firstGuard = readPiCodemodeGuardDetails(first.details);
    expect(firstGuard?.originalCode).toContain('"one"');

    // Deleting p1's record must not affect p2's.
    const second = (await firstHandler(mock, "tool_result")(toolResultEvent("p1"), ctx)) as {
      details?: unknown;
    } | undefined;
    expect(second).toBeUndefined();

    const other = (await firstHandler(mock, "tool_result")(toolResultEvent("p2"), ctx)) as {
      details?: unknown;
    };
    const secondGuard = readPiCodemodeGuardDetails(other.details);
    expect(secondGuard?.originalCode).toContain('"two"');
    expect(secondGuard?.compiledCode).not.toBe(firstGuard?.compiledCode);
  });

  it("runs the model's script untouched when the compiler throws", async () => {
    compileMock.shouldThrow = true;
    try {
      const mock = mockPi();
      codemodeGuardExtension(mock.pi);
      const ctx = mockContext();

      const event: Record<string, unknown> = {
        type: "tool_call",
        toolName: "codemode",
        toolCallId: "boom1",
        input: { code: '```js\nreturn 1;\n```' },
      };
      await firstHandler(mock, "tool_call")(event, ctx);
      expect(event.input).toMatchObject({ code: '```js\nreturn 1;\n```' });

      const result = await firstHandler(mock, "tool_result")(toolResultEvent("boom1"), ctx);
      expect(result).toBeUndefined();
    } finally {
      compileMock.shouldThrow = false;
    }
  });
});
