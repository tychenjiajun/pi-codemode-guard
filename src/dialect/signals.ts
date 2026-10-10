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

/** The dialects (or `runtime`) that own an unsupported global. */
export type UnsupportedGlobalDialect = "codex" | "ptc" | "runtime";

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
// (OpenAI Codex's helpers and timers; DeepSeek PTC's `ToolCallError`), and some
// scripts reach for general runtime APIs the sandbox lacks (the `"runtime"`
// category: timers, Intl, Web Crypto, Node APIs, browser/DOM globals — see the
// rows below). The guard
// cannot translate them, so it leaves the call in place and reports a diagnostic
// with a suggested replacement. This table is the single source of truth for
// both the detection signals and the translator's warnings — add a dialect
// global here, not in three places.

export interface UnsupportedGlobal {
  /** The identifier the other dialect defines. */
  readonly name: string;
  /**
   * Which category the global belongs to: a dialect (`codex`, `ptc`) or
   * `"runtime"` for a general-purpose runtime global another environment
   * provides that Pi's QuickJS sandbox does not. Not a `CodemodeDialect` —
   * `"runtime"` never appears in the interop contract's `dialect` field.
   */
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
  // `"runtime"` rows: globals another runtime provides that Pi's QuickJS
  // sandbox lacks. Never `distinctive` — they must not flip detection. Each
  // message states the sandbox truth and, where one exists, a Pi alternative.
  {
    name: "setInterval",
    dialect: "runtime",
    message: "`setInterval()` is unavailable: Pi's QuickJS sandbox has no timers; run the work inline",
  },
  {
    name: "clearInterval",
    dialect: "runtime",
    message: "`clearInterval()` is unavailable: Pi's QuickJS sandbox has no timers",
  },
  {
    name: "Intl",
    dialect: "runtime",
    message: "`Intl` is unavailable: Pi's QuickJS sandbox has no Intl; format manually or use `Date.prototype.toISOString()`",
  },
  {
    name: "structuredClone",
    dialect: "runtime",
    message: "`structuredClone()` is unavailable: Pi's QuickJS sandbox has no structuredClone; use `JSON.parse(JSON.stringify(x))` for JSON-safe data",
  },
  {
    name: "TextEncoder",
    dialect: "runtime",
    message: "`TextEncoder` is unavailable: Pi's QuickJS sandbox has no TextEncoder/TextDecoder; work with JS strings directly",
  },
  {
    name: "TextDecoder",
    dialect: "runtime",
    message: "`TextDecoder` is unavailable: Pi's QuickJS sandbox has no TextDecoder/TextEncoder; work with JS strings directly",
  },
  {
    name: "URL",
    dialect: "runtime",
    message: "`URL` is unavailable: Pi's QuickJS sandbox has no URL/URLSearchParams; parse and build URLs manually",
  },
  {
    name: "URLSearchParams",
    dialect: "runtime",
    message: "`URLSearchParams` is unavailable: Pi's QuickJS sandbox has no URL/URLSearchParams; parse query strings manually",
  },
  {
    name: "crypto",
    dialect: "runtime",
    message: "`crypto` is unavailable: Pi's QuickJS sandbox has no Web Crypto API (no `crypto.randomUUID()`)",
  },
  {
    name: "fetch",
    dialect: "runtime",
    message: "`fetch()` is unavailable: Pi's QuickJS sandbox has no network access; call a Pi tool instead",
  },
  {
    name: "process",
    dialect: "runtime",
    message: "`process` is unavailable: Pi's QuickJS sandbox has no Node.js runtime; use `store()`/`load()` for state",
  },
  {
    name: "require",
    dialect: "runtime",
    message: "`require()` is unavailable: Pi's QuickJS sandbox has no Node.js module loading; call a Pi tool instead",
  },
  {
    name: "Buffer",
    dialect: "runtime",
    message: "`Buffer` is unavailable: Pi's QuickJS sandbox has no Node.js Buffer; use `atob`/`btoa` for base64",
  },
  {
    name: "Atomics",
    dialect: "runtime",
    message: "`Atomics` is unavailable: Pi's QuickJS sandbox has no shared-memory atomics; coordinate with plain JavaScript",
  },
  {
    name: "WebAssembly",
    dialect: "runtime",
    message: "`WebAssembly` is unavailable: Pi's QuickJS sandbox has no WebAssembly runtime; rewrite the logic in JavaScript",
  },
  {
    name: "AbortController",
    dialect: "runtime",
    message: "`AbortController` is unavailable: Pi's QuickJS sandbox has no abort signals; stop work with a flag or an early `return`",
  },
  {
    name: "Blob",
    dialect: "runtime",
    message: "`Blob` is unavailable: Pi's QuickJS sandbox has no Blob API; work with strings or `Uint8Array`",
  },
  {
    name: "Headers",
    dialect: "runtime",
    message: "`Headers` is unavailable: Pi's QuickJS sandbox has no HTTP APIs (no network access); call a Pi tool instead",
  },
  {
    name: "Request",
    dialect: "runtime",
    message: "`Request` is unavailable: Pi's QuickJS sandbox has no HTTP APIs (no network access); call a Pi tool instead",
  },
  {
    name: "Response",
    dialect: "runtime",
    message: "`Response` is unavailable: Pi's QuickJS sandbox has no HTTP APIs (no network access); call a Pi tool instead",
  },
  {
    name: "FormData",
    dialect: "runtime",
    message: "`FormData` is unavailable: Pi's QuickJS sandbox has no form/HTTP APIs; pass a plain object to a Pi tool instead",
  },
  {
    name: "localStorage",
    dialect: "runtime",
    message: "`localStorage` is unavailable: Pi's QuickJS sandbox has no persistent storage; use `store()`/`load()`",
  },
  {
    name: "window",
    dialect: "runtime",
    message: "`window` is unavailable: Pi's QuickJS sandbox is headless (no browser global); reference the global function directly",
  },
  {
    name: "document",
    dialect: "runtime",
    message: "`document` is unavailable: Pi's QuickJS sandbox has no DOM; build and format text in JavaScript instead",
  },
  {
    name: "navigator",
    dialect: "runtime",
    message: "`navigator` is unavailable: Pi's QuickJS sandbox has no browser environment (no `navigator`)",
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
