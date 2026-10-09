// ---------------------------------------------------------------------------
// Markdown fence stripping
// ---------------------------------------------------------------------------
//
// Pi's codemode tool documents its input as "raw JavaScript source, not JSON
// and not a markdown code fence". Models that are used to chat answers wrap
// scripts in ``` fences anyway, often with a language tag and prose around the
// block:
//
//   Here is the script:
//   ```js
//   const file = await tools.read({ path: "package.json" });
//   return file;
//   ```
//
// The guard unwraps that before the script reaches the sandbox.

const OPENING_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+.-]*)[ \t]*\r?\n/;
const OPENING_FENCE_ANYWHERE = /(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+.-]*)[ \t]*\r?\n/;
const CLOSING_FENCE = /\r?\n[ \t]*(`{3,}|~{3,})[ \t]*$/;
const CLOSING_FENCE_ANYWHERE = /\r?\n[ \t]*(`{3,}|~{3,})[ \t]*(?:\r?\n|$)/;

export interface FenceStripResult {
  readonly code: string;
  readonly changed: boolean;
  readonly language?: string;
  readonly warnings: readonly string[];
}

const PROSE_MARKERS = /(?:await|const |let |var |function |tools\.|return |=>|;\s*$|\/\/)/;

/** Whether text outside a fence looks like prose rather than more code. */
function isProse(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return true;
  if (trimmed.length > 400) return false;
  if (PROSE_MARKERS.test(trimmed)) return false;
  // A brace usually means the outside text is code, not a sentence.
  return !/[{}]/.test(trimmed);
}

function stripLeadingAndTrailingFence(input: string): FenceStripResult | undefined {
  const match = input.match(OPENING_FENCE);
  if (!match) return undefined;
  const opening = match[0];
  const language = match[2] || undefined;
  let body = input.slice(opening.length);
  const closing = body.match(CLOSING_FENCE);
  if (closing) body = body.slice(0, closing.index);
  return {
    code: body.replace(/\r?\n[ \t]*$/, ""),
    changed: true,
    ...(language ? { language } : {}),
    warnings: closing ? [] : ["removed an unterminated code fence"],
  };
}

/**
 * Strip a single markdown fence that wraps the whole input, or one fenced block
 * surrounded by prose.
 */
export function stripCodeFences(input: string): FenceStripResult {
  const trimmed = input.trim();
  if (trimmed === "") return { code: input, changed: false, warnings: [] };

  const whole = stripLeadingAndTrailingFence(trimmed);
  if (whole) return whole;

  const match = trimmed.match(OPENING_FENCE_ANYWHERE);
  if (!match || match.index === undefined) return { code: input, changed: false, warnings: [] };

  const opening = match[0];
  const afterOpening = trimmed.slice(match.index + opening.length);
  const closing = afterOpening.match(CLOSING_FENCE_ANYWHERE);
  if (!closing) return whole ?? { code: input, changed: false, warnings: [] };

  const closingIndex = closing.index ?? 0;
  const before = trimmed.slice(0, match.index);
  const body = afterOpening.slice(0, closingIndex);
  const after = afterOpening.slice(closingIndex + closing[0].length);

  if (!isProse(before) || !isProse(after)) {
    return { code: input, changed: false, warnings: [] };
  }

  return {
    code: body,
    changed: true,
    ...(match[2] ? { language: match[2] } : {}),
    warnings: [],
  };
}
