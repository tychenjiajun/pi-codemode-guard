// ---------------------------------------------------------------------------
// Shared dialect signals
// ---------------------------------------------------------------------------
//
// Detection (`detect.ts`) and translation (`translate.ts`) must agree on what a
// dialect looks like. The vocabulary they share lives here so the two modules
// cannot drift: the canonical dialect list, the TanStack binding prefix, and the
// dialect globals Pi's sandbox does not define.

/** Every dialect the guard can report in `details.piCodemodeGuard`. */
export const CODEMODE_DIALECTS = [
  "pi",
  "opencode",
  "cloudflare",
  "tanstack",
  "vercel",
  "ptc",
  "codex",
  "unknown",
] as const;

export type CodemodeDialect = (typeof CODEMODE_DIALECTS)[number];

/** The dialects that own an unsupported global (not the full `CodemodeDialect`). */
export type UnsupportedGlobalDialect = "codex" | "ptc";

/** Whether `value` is a known dialect name (for parsing untrusted contract data). */
export function isCodemodeDialect(value: unknown): value is CodemodeDialect {
  return typeof value === "string" && (CODEMODE_DIALECTS as readonly string[]).includes(value);
}

/** A dialect the guard translated from — anything but already-Pi or unknown. */
export function isTranslatedDialect(dialect: CodemodeDialect): boolean {
  return dialect !== "pi" && dialect !== "unknown";
}

/** TanStack's binding prefix for tools exposed inside the sandbox. */
export const TANSTACK_BINDING_PREFIX = "external_";

// ---------------------------------------------------------------------------
// Unsupported dialect globals
// ---------------------------------------------------------------------------
//
// Other code-mode harnesses expose globals Pi's QuickJS sandbox does not define
// (OpenAI Codex's helpers and timers; DeepSeek PTC's `ToolCallError`). The guard
// cannot translate them, so it leaves the call in place and reports a diagnostic
// with a suggested replacement. This table is the single source of truth for
// both the detection signals and the translator's warnings — add a dialect
// global here, not in three places.

export interface UnsupportedGlobal {
  /** The identifier the other dialect defines. */
  readonly name: string;
  /** Which dialect the global belongs to. */
  readonly dialect: UnsupportedGlobalDialect;
  /** The warning shown when the script references it. */
  readonly message: string;
  /**
   * Distinctive enough to be a raw-text/AST dialect signal. Common JS names
   * (`setTimeout`) are left off, so an unrelated mention of them is not a
   * false-positive signal — they still warn when the script actually calls them.
   */
  readonly distinctive?: boolean;
}

export const UNSUPPORTED_GLOBALS: readonly UnsupportedGlobal[] = [
  {
    name: "audio",
    dialect: "codex",
    distinctive: true,
    message: "`audio()` is Codex-only: Pi's codemode sandbox has no audio output",
  },
  {
    name: "generatedImage",
    dialect: "codex",
    distinctive: true,
    message: "`generatedImage()` is Codex-only; append the image with Pi's `image(block)` instead",
  },
  {
    name: "notify",
    dialect: "codex",
    distinctive: true,
    message: "`notify()` is Codex-only: Pi has no out-of-band notification, use `console.log(...)`",
  },
  {
    name: "yield_control",
    dialect: "codex",
    distinctive: true,
    message: "`yield_control()` is Codex-only: Pi streams output when the script ends",
  },
  {
    name: "setTimeout",
    dialect: "codex",
    message: "`setTimeout()` is unavailable: Pi's QuickJS sandbox has no timers",
  },
  {
    name: "clearTimeout",
    dialect: "codex",
    message: "`clearTimeout()` is unavailable: Pi's QuickJS sandbox has no timers",
  },
  {
    name: "ToolCallError",
    dialect: "ptc",
    distinctive: true,
    message: "`ToolCallError` is PTC-only and undefined in Pi; catch the plain rejection value instead",
  },
];

/** `name` → the unsupported global, for the translator's reference check. */
export const UNSUPPORTED_GLOBAL_BY_NAME: ReadonlyMap<string, UnsupportedGlobal> = new Map(
  UNSUPPORTED_GLOBALS.map((entry) => [entry.name, entry]),
);

/** The distinctive subset, used as a detection signal. */
export const DISTINCTIVE_UNSUPPORTED_GLOBALS: readonly UnsupportedGlobal[] = UNSUPPORTED_GLOBALS.filter(
  (entry) => entry.distinctive === true,
);

/** `name` → distinctive unsupported global, for the detector's AST check. */
export const DISTINCTIVE_UNSUPPORTED_BY_NAME: ReadonlyMap<string, UnsupportedGlobal> = new Map(
  DISTINCTIVE_UNSUPPORTED_GLOBALS.map((entry) => [entry.name, entry]),
);

/** The detection signal for a reference to an unsupported global, e.g. `codex:notify`. */
export function unsupportedGlobalSignal(entry: UnsupportedGlobal): string {
  return `${entry.dialect}:${entry.name}`;
}
