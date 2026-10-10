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
//
// Two invariants drive the implementation:
//
//   * Best-effort: when the shape is ambiguous (a fence surrounded by what
//     looks like more code), the input is returned unchanged — dropping a line
//     of code is worse than leaving a fence pi will reject loudly.
//   * Idempotent: stripping an already-stripped result is a no-op, so nested
//     fences are unwrapped to a fixed point in a single pass rather than one
//     layer per compile.

const OPENING_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+.-]*)[ \t]*\r?\n/;
const OPENING_FENCE_ANYWHERE = /(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+.-]*)[ \t]*\r?\n/;
const CLOSING_FENCE = /\r?\n[ \t]*(`{3,}|~{3,})[ \t]*$/;
const CLOSING_FENCE_ANYWHERE = /\r?\n[ \t]*(`{3,}|~{3,})[ \t]*(?:\r?\n|$)/;
/** A lone fence marker line — an empty fenced block's content. */
const FENCE_MARKER_LINE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

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
  // Another fence means the text is more fenced material, not a sentence.
  if (/(`{3,}|~{3,})/.test(trimmed)) return false;
  // Structural characters (calls, indexing, braces, assignments, semicolons)
  // mark code — `console.log(1)` before a fence is a statement to keep, not
  // prose to discard.
  if (/[()[\]{};=]/.test(trimmed)) return false;
  // A lone identifier or dotted path is an expression statement, not prose.
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(trimmed)) return false;
  return true;
}

interface WrapperLayer {
  readonly code: string;
  readonly language?: string;
  /** The opening fence had no closing fence at all. */
  readonly unterminated: boolean;
}

/**
 * Strip one fence that wraps the entire (trimmed) input. Returns `undefined`
 * when the input does not start with an opening fence, or when a closing
 * fence is followed by text that looks like code — stripping would drop it.
 *
 * The result is always strictly shorter than the input, so callers can loop.
 */
function stripWrapperLayer(input: string): WrapperLayer | undefined {
  const match = input.match(OPENING_FENCE);
  if (!match || match.index !== 0) return undefined;
  const opening = match[0];
  const language = match[2] || undefined;
  const body = input.slice(opening.length);

  // ```js\n``` — an empty fenced block whose "content" is the closing marker.
  if (FENCE_MARKER_LINE.test(body)) {
    return { code: "", ...(language ? { language } : {}), unterminated: false };
  }

  // Closing fence is the last thing in the input.
  const atEnd = body.match(CLOSING_FENCE);
  if (atEnd && atEnd.index !== undefined) {
    const code = body.slice(0, atEnd.index).replace(/\r?\n[ \t]*$/, "");
    return { code, ...(language ? { language } : {}), unterminated: false };
  }

  // Closing fence with trailing prose: ```js\ncode\n```\nThanks!
  const anywhere = body.match(CLOSING_FENCE_ANYWHERE);
  if (anywhere && anywhere.index !== undefined) {
    const after = body.slice(anywhere.index + anywhere[0].length);
    if (isProse(after)) {
      return { code: body.slice(0, anywhere.index), ...(language ? { language } : {}), unterminated: false };
    }
    // Trailing code: refuse rather than drop it.
    return undefined;
  }

  return { code: body.replace(/\r?\n[ \t]*$/, ""), ...(language ? { language } : {}), unterminated: true };
}

/**
 * Strip every fence layer that wraps the whole input (nested fences reach a
 * fixed point in one pass). `undefined` when the input does not start with a
 * fence or the shape is ambiguous.
 */
function stripWrappedLayers(input: string): FenceStripResult | undefined {
  const warnings = new Set<string>();
  let current = input;
  let changed = false;
  let language: string | undefined;

  for (;;) {
    const layer = stripWrapperLayer(current);
    if (!layer) break;
    changed = true;
    if (language === undefined && layer.language !== undefined) language = layer.language;
    if (layer.unterminated) warnings.add("removed an unterminated code fence");
    current = layer.code;
  }

  if (!changed) return undefined;
  return {
    code: current,
    changed: true,
    ...(language ? { language } : {}),
    warnings: [...warnings],
  };
}

/**
 * Strip a single markdown fence that wraps the whole input, or one fenced block
 * surrounded by prose.
 */
export function stripCodeFences(input: string): FenceStripResult {
  const trimmed = input.trim();
  if (trimmed === "") return { code: input, changed: false, warnings: [] };

  // Input that starts with a fence is handled by the wrapper loop (which also
  // covers prose *after* the closing fence); ambiguous shapes fall through
  // unchanged.
  if (OPENING_FENCE.test(trimmed)) {
    return stripWrappedLayers(trimmed) ?? { code: input, changed: false, warnings: [] };
  }

  const match = trimmed.match(OPENING_FENCE_ANYWHERE);
  if (!match || match.index === undefined) return { code: input, changed: false, warnings: [] };

  const opening = match[0];
  const afterOpening = trimmed.slice(match.index + opening.length);
  const closing = afterOpening.match(CLOSING_FENCE_ANYWHERE);
  if (!closing || closing.index === undefined) return { code: input, changed: false, warnings: [] };

  const before = trimmed.slice(0, match.index);
  const body = afterOpening.slice(0, closing.index);
  const after = afterOpening.slice(closing.index + closing[0].length);

  if (!isProse(before) || !isProse(after)) {
    return { code: input, changed: false, warnings: [] };
  }

  // The extracted body may itself be a wrapped fence (nested blocks), so run
  // the same loop over it to keep the pass idempotent.
  const inner = stripWrappedLayers(body);
  const code = inner ? inner.code : body;
  const language = match[2] || inner?.language;
  return {
    code,
    changed: true,
    ...(language ? { language } : {}),
    warnings: inner?.warnings ?? [],
  };
}
