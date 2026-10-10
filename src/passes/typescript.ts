// ---------------------------------------------------------------------------
// TypeScript -> JavaScript stripping (TanStack AI code mode)
// ---------------------------------------------------------------------------
//
// TanStack's `execute_typescript` sandbox takes TypeScript: the model writes
// annotations, interfaces, generics, and `as` assertions. Pi's QuickJS sandbox
// runs plain JavaScript, so the TanStack compiler has to strip those first, or
// the later acorn passes cannot parse the script.
//
// `sucrase` is the same type-stripper TanStack uses, and its `transform` is
// synchronous and pure, so the pass stays a string -> string transformation.
// As in TanStack, the source is wrapped in an async function so top-level
// `return`/`await` survive the transform, then the wrapper is removed again.
//
// The pass is best-effort: a script sucrase rejects (or a wrapper sucrase
// reformats beyond recognition) is returned unchanged with a warning.

import { transform } from "sucrase";

const WRAPPER_START = "___PI_GUARD_TS_WRAPPER_START___";
const WRAPPER_END = "___PI_GUARD_TS_WRAPPER_END___";

/**
 * Pick wrapper markers that do not occur in the input. A literal marker in the
 * user's script would otherwise be found first by `indexOf` and silently
 * truncate the body at that point — the one silent code-loss path in the
 * compiler. Deterministic (derived from the input), so the pass stays pure.
 */
function uniqueMarker(code: string, base: string): string {
  let marker = base;
  while (code.includes(marker)) marker += "_";
  return marker;
}

export interface TypeScriptStripResult {
  readonly code: string;
  readonly changed: boolean;
  readonly warnings: readonly string[];
}

const FAILED: readonly string[] = ["could not strip TypeScript syntax; left unchanged"];

/**
 * Strip TypeScript-only syntax from a codemode script, returning plain
 * JavaScript. A no-op on already-JavaScript input.
 */
export function stripTypeScriptSyntax(code: string): TypeScriptStripResult {
  const startMarker = uniqueMarker(code, WRAPPER_START);
  const endMarkerText = uniqueMarker(code, WRAPPER_END);
  const wrapped = `async function ${startMarker}() {\n${code}\n}; ${endMarkerText}`;

  let transformed: string;
  try {
    transformed = transform(wrapped, { transforms: ["typescript"], disableESTransforms: true }).code;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { code, changed: false, warnings: [`could not strip TypeScript syntax (${reason}); left unchanged`] };
  }

  const functionStart = transformed.indexOf(`async function ${startMarker}()`);
  const openBrace = functionStart === -1 ? -1 : transformed.indexOf("{", functionStart);
  const endMarker = transformed.indexOf(endMarkerText);
  if (openBrace === -1 || endMarker === -1 || endMarker < openBrace) {
    return { code, changed: false, warnings: FAILED };
  }

  const beforeEndMarker = transformed.slice(openBrace + 1, endMarker);
  const closingBrace = beforeEndMarker.lastIndexOf("}");
  if (closingBrace === -1) {
    return { code, changed: false, warnings: FAILED };
  }

  const body = beforeEndMarker.slice(0, closingBrace).trim();
  return { code: body, changed: body !== code, warnings: [] };
}