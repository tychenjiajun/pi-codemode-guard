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
// The guard rewrites the line into the canonical form, maps the common field
// aliases, and drops the options entirely when nothing usable remains so an
// invalid line cannot fail the whole script.

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

// Pi only accepts `// @options:` on the first line, but models routinely drop
// the `@`. The guard still normalizes those — but only when the body is an
// object literal: `// options: use timeout: 30000` is prose, not a directive,
// and must pass through untouched. The `@` form is always taken as a
// directive (pi would reject the script otherwise) and neutralized with a
// warning when it does not parse.
const COMMENT_PREFIX = "(?:\\/\\/+|#|\\/\\*+|<!--)";
const DIRECTIVE_AT = new RegExp(
  `^${COMMENT_PREFIX}\\s*@options?\\b\\s*[:=]?\\s*(.*?)\\s*(?:\\*\\/|-->)?\\s*$`,
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function quoteUnquotedKeys(text: string): string {
  return text.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
}

function normalizeSingleQuotes(text: string): string {
  return text.replace(/'((?:\\.|[^'\\])*)'/g, (_, inner: string) => `"${inner.replace(/"/g, '\\"')}"`);
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, "$1");
}

function parseKeyValuePairs(text: string): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  const pattern = /([A-Za-z_][\w]*)\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,;\n]+)/g;
  let match: RegExpExecArray | null;
  let found = false;
  while ((match = pattern.exec(text)) !== null) {
    found = true;
    const raw = match[2]!.trim();
    result[match[1]!] = tryJson(raw) ?? raw.replace(/^['"]|['"]$/g, "");
  }
  return found ? result : undefined;
}

/** Parse a tolerant, JSON-ish options body into an object. */
export function parseLooseOptionsObject(raw: string): Record<string, unknown> | undefined {
  const text = raw.trim();
  if (text === "") return {};
  const candidates = [
    text,
    removeTrailingCommas(quoteUnquotedKeys(text)),
    removeTrailingCommas(quoteUnquotedKeys(normalizeSingleQuotes(text))),
  ];
  for (const candidate of candidates) {
    const parsed = tryJson(candidate);
    if (isRecord(parsed)) return parsed;
  }
  return parseKeyValuePairs(text);
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

  const scanLimit = Math.min(lines.length, 12);
  for (let index = 0; index < scanLimit; index++) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    if (!isCommentLine(line)) break;
    const match = line.match(DIRECTIVE_AT) ?? line.match(DIRECTIVE_BARE);
    if (match) {
      foundIndex = index;
      directiveBody = match[1] ?? "";
      break;
    }
  }

  if (foundIndex === -1) return { body: code, changed: false, warnings: [] };

  const withoutLine = [...lines];
  withoutLine.splice(foundIndex, 1);

  const parsedObject = parseLooseOptionsObject(directiveBody);
  const options = parsedObject ? mapCodemodeOptions(parsedObject) : undefined;

  if (!options) {
    // Neutralize the line instead of removing it, so the number of lines stays
    // close to the original and nothing silently disappears.
    withoutLine.splice(foundIndex, 0, "// pi-codemode-guard: ignored an unparseable @options line");
    return {
      body: withoutLine.join("\n"),
      changed: true,
      warnings: ["removed an @options line that pi would reject"],
    };
  }

  return {
    body: withoutLine.join("\n"),
    optionsLine: formatOptionsLine(options),
    changed: true,
    warnings: [],
  };
}
