// ---------------------------------------------------------------------------
// `// @options:` line normalization
// ---------------------------------------------------------------------------
//
// A codemode script may start with one options line:
//
//   // @options: {"max_output_tokens": 2000, "timeout_ms": 60000}
//
// Pi only accepts that exact shape on the very first line and requires strict
// JSON with the exact field names. Models routinely get the comment syntax,
// the JSON syntax, or the field names wrong:
//
//   // @options {"max_output_tokens": 2000}      (no colon)
//   /* @options: {'max_output_tokens': 2000} */  (block comment, single quotes)
//   // options: {maxOutputTokens: 2000}           (unquoted key, camelCase)
//   // @options: {"timeout": 30}                  (wrong field name)
//
// OpenAI Codex's code mode uses its own pragma with a different field set:
//
//   // @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}
//
// `max_output_tokens` maps to Pi's field; `yield_time_ms` is a yield hint with
// no Pi equivalent (Pi streams when the script ends), so it is dropped with a
// warning rather than misread as `timeout_ms`.
//
// The guard rewrites the line into the canonical form, maps the common field
// aliases, and drops the options entirely when nothing usable remains so an
// invalid line cannot fail the whole script.
//
// Since pi 1.2.0, `parseCodemodeSource` *fails the call* when a line starting
// with `// @options:` sits anywhere but the first line (before 1.2.0 it was
// silently ignored). The leading-block scan below never reaches such lines
// (they follow code, are indented past the scan, or fall below its 12-line
// window), so a second pass relocates the first one to the front and
// neutralizes any others — an exact-prefix line left in place would now reject
// the whole script.

import { parseLooseOptionsObject } from "./loose-json.ts";
/** Keys accepted for `max_output_tokens`. */
const MAX_OUTPUT_TOKENS_ALIASES = [
  "max_output_tokens",
  "max_output_token",
  "maxOutputTokens",
  "maxOutputToken",
  "max_tokens",
  "maxTokens",
  "output_tokens",
  "outputTokens",
  "maxOutputTokenCount",
] as const;

/** Keys accepted for `timeout_ms`. */
const TIMEOUT_MS_ALIASES = [
  "timeout_ms",
  "timeoutMs",
  "timeout_milliseconds",
  "timeoutMilliseconds",
  "timeoutMillis",
  "timeout",
  "deadline_ms",
  "deadlineMs",
] as const;

const MAX_TIMEOUT_MS = 2_147_483_647;

/** Codex `@exec` fields with no Pi equivalent (a yield hint, not a timeout). */
const YIELD_TIME_ALIASES = ["yield_time_ms", "yieldTimeMs", "yield_time", "yieldTime"] as const;

// Pi only accepts `// @options:` on the first line, but models routinely drop
// the `@`. The guard still normalizes those — but only when the body is an
// object literal: `// options: use timeout: 30000` is prose, not a directive,
// and must pass through untouched. The `@` form is always taken as a
// directive (pi would reject the script otherwise) and neutralized with a
// warning when it does not parse.
/** Pi's exact options prefix (`pi-codemode` `parseCodemodeSource`). */
const PI_OPTIONS_PREFIX = "// @options:";
const COMMENT_PREFIX = "(?:\\/\\/+|#|\\/\\*+|<!--)";
const DIRECTIVE_AT = new RegExp(
  `^${COMMENT_PREFIX}\\s*@(options?|exec)\\b\\s*[:=]?\\s*(.*?)\\s*(?:\\*\\/|-->)?\\s*$`,
  "i",
);
const DIRECTIVE_BARE = new RegExp(
  `^${COMMENT_PREFIX}\\s*options?\\s*[:={]?\\s*(\\{.*?)\\s*(?:\\*\\/|-->)?\\s*$`,
  "i",
);

export interface ParsedCodemodeOptions {
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
}

export interface OptionsSplitResult {
  /** Canonical first line, when options survived. */
  readonly optionsLine?: string;
  /** The script without the original options line. */
  readonly body: string;
  readonly changed: boolean;
  readonly warnings: readonly string[];
  /** Which pragma was found: Pi's `@options` or Codex's `@exec`. */
  readonly directive?: "options" | "exec";
}

function asPositiveInteger(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) return undefined;
  return number;
}

/**
 * Map the aliases of an options object to pi's fields. Returns `undefined` when
 * no recognized field survives. A present-but-invalid value falls through to
 * the next alias (`{"max_output_tokens": "abc", "maxTokens": 500}` keeps the
 * 500) instead of dropping the whole line.
 */
export function mapCodemodeOptions(fields: Record<string, unknown>): ParsedCodemodeOptions | undefined {
  const options: { maxOutputTokens?: number; timeoutMs?: number } = {};

  for (const key of MAX_OUTPUT_TOKENS_ALIASES) {
    if (!(key in fields)) continue;
    const value = asPositiveInteger(fields[key]);
    if (value === undefined) continue; // invalid for this alias; try the next
    options.maxOutputTokens = value;
    break;
  }

  for (const key of TIMEOUT_MS_ALIASES) {
    if (!(key in fields)) continue;
    const value = asPositiveInteger(fields[key]);
    // Pi requires a positive integer up to 2147483647 (0 is rejected there),
    // so mirror that and keep looking at the remaining aliases.
    if (value === undefined || value === 0 || value > MAX_TIMEOUT_MS) continue;
    options.timeoutMs = value;
    break;
  }

  if (Object.keys(options).length === 0) return undefined;
  return options;
}

function formatOptionsLine(options: ParsedCodemodeOptions): string {
  const fields: string[] = [];
  if (options.maxOutputTokens !== undefined) fields.push(`"max_output_tokens": ${options.maxOutputTokens}`);
  if (options.timeoutMs !== undefined) fields.push(`"timeout_ms": ${options.timeoutMs}`);
  return `// @options: {${fields.join(", ")}}`;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === "" ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("<!--")
  );
}

/**
 * Split an optional leading options line from the script and return it in pi's
 * canonical form.
 */
export function splitOptionsLine(code: string): OptionsSplitResult {
  const lines = code.split("\n");
  let foundIndex = -1;
  let directiveBody = "";
  let directive: "options" | "exec" = "options";

  const scanLimit = Math.min(lines.length, 12);
  for (let index = 0; index < scanLimit; index++) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    if (!isCommentLine(line)) break;
    const trimmed = line.trimStart();
    const at = trimmed.match(DIRECTIVE_AT);
    if (at) {
      foundIndex = index;
      directive = (at[1] ?? "").toLowerCase() === "exec" ? "exec" : "options";
      directiveBody = at[2] ?? "";
      break;
    }
    const bare = trimmed.match(DIRECTIVE_BARE);
    if (bare) {
      foundIndex = index;
      directive = "options";
      directiveBody = bare[1] ?? "";
      break;
    }
  }

  // Lines the leading-block scan never reached that pi 1.2.0 would reject:
  // anything starting with the exact `// @options:` prefix at index > 0
  // (pi only accepts it on the first line). Promote the first one to the
  // directive; neutralize the rest so no exact-prefix line survives.
  const misplaced: number[] = [];
  for (let index = 1; index < lines.length; index++) {
    if (index === foundIndex) continue;
    if (lines[index]!.trimStart().startsWith(PI_OPTIONS_PREFIX)) misplaced.push(index);
  }
  let promoted = false;
  if (foundIndex === -1 && misplaced.length > 0) {
    const index = misplaced.shift()!;
    const trimmed = lines[index]!.trimStart();
    const at = trimmed.match(DIRECTIVE_AT);
    foundIndex = index;
    directive = "options";
    directiveBody = at?.[2] ?? trimmed.slice(PI_OPTIONS_PREFIX.length);
    promoted = true;
  }

  if (foundIndex === -1) return { body: code, changed: false, warnings: [] };

  const withoutLine = [...lines];
  // Replace in place (no splice) so the indices stay stable for the removal
  // below.
  for (const index of misplaced) {
    withoutLine[index] =
      "// pi-codemode-guard: removed a misplaced @options line (Pi requires it on the first line)";
  }
  withoutLine.splice(foundIndex, 1);

  const parsedObject = parseLooseOptionsObject(directiveBody);
  const options = parsedObject ? mapCodemodeOptions(parsedObject) : undefined;
  const warnings: string[] = [];
  if (promoted) {
    warnings.push("moved a misplaced `// @options:` line to the first line (Pi requires it there)");
  }
  if (misplaced.length > 0) {
    warnings.push("removed a duplicate `// @options:` line (Pi allows it only on the first line)");
  }
  if (directive === "exec" && parsedObject && YIELD_TIME_ALIASES.some((key) => key in parsedObject)) {
    warnings.push("dropped `yield_time_ms` from the @exec pragma; Pi streams output when the script ends");
  }

  if (!options) {
    // Neutralize the line instead of removing it, so the number of lines stays
    // close to the original and nothing silently disappears.
    withoutLine.splice(foundIndex, 0, `// pi-codemode-guard: ignored an unparseable @${directive} line`);
    warnings.push(`removed an @${directive} line that pi would reject`);
    return { body: withoutLine.join("\n"), changed: true, warnings, directive };
  }

  return {
    body: withoutLine.join("\n"),
    optionsLine: formatOptionsLine(options),
    changed: true,
    warnings,
    directive,
  };
}
