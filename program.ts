// ---------------------------------------------------------------------------
// JSON tool-call programs -> codemode JavaScript
// ---------------------------------------------------------------------------
//
// Some models do not write JavaScript at all. They emit the tool calls they
// want as JSON, either as the whole `code` value or as the tool-call arguments:
//
//   [{ "tool": "read", "args": { "path": "package.json" } },
//    { "tool": "bash", "args": { "command": "ls" } }]
//
// or a single call:
//
//   { "toolName": "read", "input": { "path": "package.json" } }
//
// Pi's codemode tool rejects that, so the guard compiles it into the script the
// model meant: a sequential `await tools.<id>({ ... })` for every step, with
// the collected results returned as the script output.

import { toCodemodeIdentifier } from "./identifiers.ts";

/** Thrown when a value passed to the program compiler is not a tool call. */
export class CodemodeProgramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodemodeProgramError";
  }
}

/** Keys that name the tool in a step object, most specific first. */
const TOOL_KEYS = ["tool", "toolName", "tool_name", "name", "function", "fn", "action", "method"] as const;

/** Keys that hold the arguments of a step object, most specific first. */
const ARG_KEYS = ["args", "arguments", "input", "params", "parameters", "payload"] as const;

export interface CompiledToolCall {
  readonly tool: string;
  readonly args: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgsValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { command: value };
  }
}

function collectRest(step: Record<string, unknown>, skip: readonly string[]): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(step)) {
    if (!skip.includes(key)) rest[key] = value;
  }
  return rest;
}

/**
 * Interpret one value as a tool call. Supports an explicit tool key with
 * separate arguments, inline arguments next to the tool key, and the
 * single-key shorthand `{ "read": { "path": "package.json" } }`.
 *
 * Returns `undefined` for values that are not tool calls.
 */
export function toToolCall(step: unknown): CompiledToolCall | undefined {
  if (!isRecord(step)) return undefined;

  const toolKey = TOOL_KEYS.find((key) => typeof step[key] === "string");
  if (toolKey !== undefined) {
    const tool = step[toolKey] as string;
    const argsKey = ARG_KEYS.find((key) => key in step);
    const rawArgs = argsKey !== undefined ? step[argsKey] : collectRest(step, [toolKey, ...ARG_KEYS]);
    return { tool, args: parseArgsValue(rawArgs) };
  }

  const keys = Object.keys(step);
  if (keys.length === 1) {
    const only = keys[0]!;
    const value = step[only]!;
    if (isRecord(value) || Array.isArray(value)) {
      return { tool: only, args: value };
    }
  }

  return undefined;
}

/**
 * Compile a JSON tool-call program to codemode JavaScript. `steps` may mix tool
 * calls with raw JavaScript lines; string steps are emitted verbatim.
 *
 * Throws {@link CodemodeProgramError} when a step is neither a tool call nor a
 * string.
 */
export function programToJs(steps: readonly unknown[]): string {
  const lines: string[] = [];
  const results: string[] = [];
  let index = 0;

  for (const step of steps) {
    if (typeof step === "string") {
      lines.push(step);
      continue;
    }
    const call = toToolCall(step);
    if (!call) {
      throw new CodemodeProgramError(
        `Unrecognized codemode program step: ${JSON.stringify(step)}. Expected a tool call like {"tool":"read","args":{"path":"..."}} or raw JavaScript.`,
      );
    }
    const name = `_result${index++}`;
    lines.push(`const ${name} = await tools.${toCodemodeIdentifier(call.tool)}(${JSON.stringify(call.args)});`);
    results.push(name);
  }

  if (results.length === 0) return lines.join("\n");
  if (results.length === 1) {
    lines.push(`return ${results[0]};`);
  } else {
    lines.push(`return [${results.join(", ")}];`);
  }
  return lines.join("\n");
}

/**
 * Whether a value is plausibly a JSON tool-call program rather than JavaScript.
 * Used to decide whether to try {@link programToJs} before parsing as JS.
 */
export function looksLikeToolProgram(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((step) => typeof step === "string" || toToolCall(step) !== undefined);
  }
  if (isRecord(value)) return toToolCall(value) !== undefined;
  return false;
}
