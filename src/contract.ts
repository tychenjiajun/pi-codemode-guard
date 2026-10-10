// ---------------------------------------------------------------------------
// Cross-extension contract: details.piCodemodeGuard
// ---------------------------------------------------------------------------
//
// When the guard rewrites a codemode script it records exactly what happened on
// the tool result as `details.piCodemodeGuard`, so a downstream consumer (for
// example an evidence-preserving reducer or an audit log) can tell the script
// the model wrote from the script that ran:
//
//   * `originalCode` — the argument pi validated, before the compiler ran,
//   * `compiledCode` — the script the sandbox received,
//   * `passes` — the compile passes that applied, in order,
//   * `warnings` — e.g. an `@options` line the guard had to drop.
//
// The shape is versioned and additive-only. Consumers must ignore unknown
// fields and fall back to the inline content when `version` is not understood.

import { isRecord } from "./core/guards.ts";
import { isCodemodeDialect, type CodemodeDialect } from "./dialect/signals.ts";

export const PI_CODEMODE_GUARD_DETAILS_KEY = "piCodemodeGuard" as const;
export const PI_CODEMODE_GUARD_CONTRACT_VERSION = 1 as const;

export interface PiCodemodeGuardDetails {
  readonly version: typeof PI_CODEMODE_GUARD_CONTRACT_VERSION;
  /** The source pi validated, before the compiler ran. */
  readonly originalCode: string;
  /** The source the sandbox received. */
  readonly compiledCode: string;
  /** Applied pass ids, in order. */
  readonly passes: readonly string[];
  /** Whether the compiler could parse (or recognize) the source. */
  readonly parsed: boolean;
  /** The dialect the model wrote: `pi`, `opencode`, `cloudflare`, `tanstack`, `vercel`, `ptc`, `codex`, or `unknown`. */
  readonly dialect: CodemodeDialect;
  /** Non-fatal problems. */
  readonly warnings: readonly string[];
}

function readDialect(value: unknown): CodemodeDialect {
  return isCodemodeDialect(value) ? value : "unknown";
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return value as string[];
}

/** Parse `details.piCodemodeGuard`, or `undefined` for unknown/missing records. */
export function readPiCodemodeGuardDetails(details: unknown): PiCodemodeGuardDetails | undefined {
  if (!isRecord(details)) return undefined;
  const record = details[PI_CODEMODE_GUARD_DETAILS_KEY];
  if (!isRecord(record)) return undefined;

  const { version, originalCode, compiledCode, passes, parsed, dialect, warnings } = record;
  if (version !== PI_CODEMODE_GUARD_CONTRACT_VERSION) return undefined;
  if (typeof originalCode !== "string" || typeof compiledCode !== "string") return undefined;
  const parsedPasses = readStringArray(passes);
  const parsedWarnings = readStringArray(warnings);
  if (!parsedPasses || !parsedWarnings) return undefined;

  return {
    version: PI_CODEMODE_GUARD_CONTRACT_VERSION,
    originalCode,
    compiledCode,
    passes: parsedPasses,
    parsed: parsed === true,
    dialect: readDialect(dialect),
    warnings: parsedWarnings,
  };
}
