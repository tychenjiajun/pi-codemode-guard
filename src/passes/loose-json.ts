// ---------------------------------------------------------------------------
// Tolerant JSON repair
// ---------------------------------------------------------------------------
//
// Models write the `@options` body (and similar small objects) in almost-JSON:
// unquoted keys, single quotes, trailing commas, or `key: value` pairs with no
// braces at all. This module turns those into an object, best-effort, so the
// options pass can stay focused on the directive itself.

import { isRecord } from "../core/guards.ts";

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
