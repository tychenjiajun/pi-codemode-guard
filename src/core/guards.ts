// ---------------------------------------------------------------------------
// Value-shape guards
// ---------------------------------------------------------------------------
//
// `isRecord` is the compiler's one "is this a plain object" check. It inspects
// untrusted input in several places — codemode arguments, options fields, JSON
// programs, the interop contract — so it lives here rather than being copied
// into each module.

/** Whether `value` is a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
