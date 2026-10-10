// ---------------------------------------------------------------------------
// Source-range replacements
// ---------------------------------------------------------------------------
//
// Every pass that rewrites identifiers — `translateCodemode` and
// `rewriteToolIdentifiers` — collects `{ start, end, text }` replacements
// against the original source and splices them back to front. The selection
// rule (the outermost non-overlapping range wins) and the splice loop are
// shared here so the two passes cannot drift apart.

export interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Keep the outermost non-overlapping replacements: an inner `tools.a.b` inside
 * `tools.a.b.c` is dropped, and two replacements that overlap are not both
 * applied.
 */
export function selectReplacements<T extends Replacement>(candidates: readonly T[]): T[] {
  const sorted = [...candidates].sort((a, b) => a.start - b.start || a.end - b.end);
  const chosen: T[] = [];
  let lastEnd = -1;
  for (const candidate of sorted) {
    if (candidate.start < lastEnd) continue;
    chosen.push(candidate);
    lastEnd = candidate.end;
  }
  return chosen;
}

/** Splice replacements into `code`, back to front so earlier offsets stay valid. */
export function applyReplacements(code: string, replacements: readonly Replacement[]): string {
  const ordered = [...replacements].sort((a, b) => b.start - a.start);
  let result = code;
  for (const replacement of ordered) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return result;
}
