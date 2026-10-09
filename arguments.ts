// ---------------------------------------------------------------------------
// Tool-call argument normalization
// ---------------------------------------------------------------------------
//
// Pi validates tool arguments before any execution hook runs, so a codemode
// call whose arguments are not `{ code: string }` never reaches `tool_call`.
// The guard therefore replaces the built-in codemode tool with one that adds a
// `prepareArguments` shim (see `index.ts`), and this module is that shim's
// brain.
//
// Accepted shapes:
//   "await tools.read(...)"                       -> raw JavaScript string
//   { code: "await tools.read(...)" }             -> canonical
//   { script|source|javascript|js|input|body|... }-> field aliases
//   { code: { language, content } }               -> nested source object
//   { tool: "read", args: { path: "a" } }         -> single JSON tool call
//   { tool_calls: [ ... ] }                       -> JSON tool-call program
//   [ { tool: "read", args: {...} }, ... ]        -> JSON tool-call program
//   [ "await tools.read(...)", ... ]              -> raw JavaScript lines

import { programToJs, toToolCall } from "./program.ts";

/** Thrown when the tool arguments cannot be interpreted as a codemode script. */
export class CodemodeArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodemodeArgumentError";
  }
}

export type ArgumentSourceKind =
  | "raw-string"
  | "code-field"
  | "nested-code"
  | "alias-field"
  | "tool-call"
  | "tool-program"
  | "step-array";

export interface CoercedArguments {
  readonly code: string;
  readonly kind: ArgumentSourceKind;
  /** The field that carried the code or program, when one did. */
  readonly field?: string;
}

/** Aliases for the `code` field, in priority order. */
export const CODE_FIELD_ALIASES = [
  "script",
  "source",
  "javascript",
  "typescript",
  "js",
  "source_code",
  "sourceCode",
  "typescript_code",
  "typescriptCode",
  "program",
  "input",
  "body",
  "content",
  "text",
] as const;

/** Aliases for a container of tool-call steps, in priority order. */
export const PROGRAM_FIELD_ALIASES = [
  "tool_calls",
  "toolCalls",
  "calls",
  "steps",
  "commands",
  "actions",
  "plan",
] as const;

/** Keys a nested source object may use for its JavaScript. */
const NESTED_SOURCE_KEYS = ["code", "content", "source", "text", "script", "body", "js", "javascript"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractNestedSource(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of NESTED_SOURCE_KEYS) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function programFromArray(value: readonly unknown[]): string {
  if (value.length === 0) {
    throw new CodemodeArgumentError("Received an empty codemode program. Provide JavaScript or at least one tool call.");
  }
  try {
    return programToJs(value);
  } catch (error) {
    throw new CodemodeArgumentError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Interpret arbitrary tool-call arguments as codemode source. Throws
 * {@link CodemodeArgumentError} when nothing recognizable is present.
 */
export function coerceCodemodeArguments(args: unknown): CoercedArguments {
  if (typeof args === "string") {
    return { code: args, kind: "raw-string" };
  }

  if (Array.isArray(args)) {
    return { code: programFromArray(args), kind: "step-array" };
  }

  if (!isRecord(args)) {
    throw new CodemodeArgumentError(
      `Codemode arguments must be an object with a \`code\` string, a raw JavaScript string, or a JSON tool-call program; got ${args === null ? "null" : typeof args}.`,
    );
  }

  if ("code" in args) {
    const value = args.code;
    if (typeof value === "string") {
      return { code: value, kind: "code-field", field: "code" };
    }
    const nested = extractNestedSource(value);
    if (nested !== undefined) {
      return { code: nested, kind: "nested-code", field: "code" };
    }
    if (Array.isArray(value)) {
      return { code: programFromArray(value), kind: "tool-program", field: "code" };
    }
    // `code` is present but unusable; fall through to the aliases so a model
    // that sent `{ code: 42, script: "..." }` still gets its script run.
  }

  for (const field of CODE_FIELD_ALIASES) {
    const value = args[field];
    if (typeof value === "string") {
      return { code: value, kind: "alias-field", field };
    }
    const nested = extractNestedSource(value);
    if (nested !== undefined) {
      return { code: nested, kind: "nested-code", field };
    }
  }

  for (const field of PROGRAM_FIELD_ALIASES) {
    const value = args[field];
    if (Array.isArray(value)) {
      return { code: programFromArray(value), kind: "tool-program", field };
    }
  }

  if (toToolCall(args) !== undefined) {
    return { code: programFromArray([args]), kind: "tool-call" };
  }

  throw new CodemodeArgumentError(
    "Could not read a codemode script from the tool arguments. Send `{ code: <JavaScript source> }` (code must be a string), or raw JavaScript, or a JSON tool-call program such as `[{ \"tool\": \"read\", \"args\": { \"path\": \"package.json\" } }]`.",
  );
}

/**
 * `prepareArguments` shim for the codemode tool. Always returns the canonical
 * `{ code }` shape pi validates against.
 */
export function normalizeCodemodeArguments(args: unknown): { code: string } {
  return { code: coerceCodemodeArguments(args).code };
}
