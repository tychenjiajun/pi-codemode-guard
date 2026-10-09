// ---------------------------------------------------------------------------
// pi-codemode-guard
// ---------------------------------------------------------------------------
//
// Pi's `codemode` tool asks the model for raw JavaScript, but many models write
// something else: a markdown fence, a JSON tool-call program, an async IIFE, a
// relaxed `@options:` line, or JavaScript that forgot the `await` on a tool call
// (which pi then serializes as `{}`, see pi issue #10555).
//
// The guard wraps the built-in codemode tool with two hooks:
//
//   * `prepareArguments` (installed on the tool definition) normalizes the
//     tool-call arguments before pi validates them, so a raw string, an alias
//     field, or a JSON program reaches the sandbox instead of a validation
//     error.
//   * the `tool_call` event compiles the validated `code` in place, and the
//     `tool_result` event stamps `details.piCodemodeGuard` for downstream
//     consumers.
//
// To keep the built-in behavior (the `models` namespace, the `store()` writes,
// the `codemode.mode` setting) the guard does not reimplement the tool: it runs
// `createCodemodeExtension()` through a small `pi` facade that adds the
// argument shim to the tool the extension registers.

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";

import { normalizeCodemodeArguments } from "./arguments.ts";
import { compileCodemodeSource, type CompileResult } from "./compile.ts";
import {
  PI_CODEMODE_GUARD_DETAILS_KEY,
  PI_CODEMODE_GUARD_CONTRACT_VERSION,
  readPiCodemodeGuardDetails,
  type PiCodemodeGuardDetails,
} from "./contract.ts";
import { applyCompileReceipt, showGuardStatus, type ChildContainer } from "./ui.ts";

interface CompilationRecord {
  readonly originalCode: string;
  readonly result: CompileResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toDetails(record: CompilationRecord): PiCodemodeGuardDetails {
  return {
    version: PI_CODEMODE_GUARD_CONTRACT_VERSION,
    originalCode: record.originalCode,
    compiledCode: record.result.code,
    passes: [...record.result.passes],
    parsed: record.result.parsed,
    dialect: record.result.dialect,
    warnings: [...record.result.warnings],
  };
}

/**
 * Add the argument-normalization shim (and the compile receipt) to a tool
 * definition. Tools other than `codemode` pass through untouched.
 */
export function augmentCodemodeTool(tool: ToolDefinition): ToolDefinition {
  if (tool.name !== "codemode") return tool;

  const originalRenderResult = tool.renderResult;
  return {
    ...tool,
    prepareArguments: (args: unknown) => normalizeCodemodeArguments(args),
    ...(originalRenderResult
      ? {
          renderResult(result, options, theme, context) {
            const component = originalRenderResult(result, options, theme, context);
            if (options.isPartial) return component;
            const guard = readPiCodemodeGuardDetails(result.details);
            if (guard) applyCompileReceipt(component as unknown as ChildContainer, theme, guard);
            return component;
          },
        }
      : {}),
  };
}

/**
 * A `pi` facade whose `registerTool` augments the codemode tool. Everything
 * else is forwarded to the real extension API.
 */
export function createGuardedCodemodeApi(pi: ExtensionAPI): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (tool: ToolDefinition) => {
          target.registerTool(augmentCodemodeTool(tool));
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ExtensionAPI;
}

function notifyCompiled(ctx: ExtensionContext, result: CompileResult): void {
  const summary = result.passes.join(", ");
  const dialect = result.dialect === "opencode" ? "opencode → pi" : result.dialect;
  showGuardStatus(ctx, `🛡 ${dialect} · ${summary}`);
  if (ctx.hasUI) {
    ctx.ui.notify(`pi-codemode-guard: compiled codemode script (${dialect}; ${summary})`, "info");
  }
}

export default function codemodeGuardExtension(pi: ExtensionAPI): void {
  // Replace the built-in codemode tool with a guarded copy. Registering
  // `codemode` during load also makes pi drop its replaceable built-in
  // codemode extension, so the tool is registered exactly once.
  createCodemodeExtension()(createGuardedCodemodeApi(pi));

  const records = new Map<string, CompilationRecord>();

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "codemode") return;

    const input = event.input as Record<string, unknown>;
    const code = input.code;
    if (typeof code !== "string") return;

    let result: CompileResult;
    try {
      result = compileCodemodeSource(code, { tools: pi.getAllTools().map((tool) => tool.name) });
    } catch {
      // A guard bug must never block the tool: run the model's script as-is.
      return;
    }
    if (!result.changed) return;

    records.set(event.toolCallId, { originalCode: code, result });
    input.code = result.code;
    notifyCompiled(ctx, result);
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "codemode") return;
    const record = records.get(event.toolCallId);
    if (!record) return;
    records.delete(event.toolCallId);

    const details = isRecord(event.details) ? event.details : {};
    return { details: { ...details, [PI_CODEMODE_GUARD_DETAILS_KEY]: toDetails(record) } };
  });
}
