import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { readPiCodemodeGuardDetails } from "./contract.ts";
import codemodeGuardExtension, { augmentCodemodeTool } from "./index.ts";

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
});
