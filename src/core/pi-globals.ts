// ---------------------------------------------------------------------------
// Pi codemode sandbox globals
// ---------------------------------------------------------------------------
//
// Pi injects a fixed set of identifiers into the codemode sandbox. Three passes
// need them: the await pass (the lookup helpers return promises), the detector
// (a lookup helper is a Pi signal), and the translator (a sandbox global is
// neither a tool nor a Cloudflare provider). Keeping the vocabulary here means
// adding a helper is one edit, not three.

/** Promise-returning lookup helpers Pi injects into the sandbox. */
export const PI_LOOKUP_HELPERS = ["searchTools", "describeTool", "describeNamespace"] as const;

/** Every non-tool identifier Pi injects into the codemode sandbox. */
export const PI_SANDBOX_GLOBALS: readonly string[] = [
  "tools",
  "models",
  "text",
  "image",
  "ALL_TOOLS",
  ...PI_LOOKUP_HELPERS,
  "store",
  "load",
  "exit",
  "queueMicrotask",
];

/**
 * The parameters of Pi's wrapper function. Pi runs every script as the body of
 * `(async (tools, console) => { <script> })` (see pi's codemode-worker), so a
 * *lexical* declaration of either name at the top level of the script —
 * `let`/`const`/`class`, including destructuring bindings — is a syntax error
 * in the sandbox (QuickJS: `invalid redefinition of parameter name`). `var`
 * and `function` declarations are var-scoped and legal (they redeclare the
 * parameter binding), and declarations in nested scopes shadow the parameter
 * without conflicting. Consumed by `passes/wrapper.ts`, which renames the
 * colliding binding.
 */
export const PI_WRAPPER_PARAMS: readonly string[] = ["tools", "console"];

/**
 * Real QuickJS builtins that ARE present in Pi's codemode sandbox (verified
 * against `Object.getOwnPropertyNames(globalThis)` in the live sandbox),
 * beyond the injected globals above. This is a pure data list consumed by
 * `dialect/translate.ts`: these names must never be mistaken for a provider
 * namespace (`performance.now()` is valid and must stay silent) or for a bare
 * tool name. It exists so "present in the sandbox" has one home — the
 * "absent from the sandbox" vocabulary is `UNSUPPORTED_GLOBALS` in
 * `dialect/signals.ts`. Both this table and `JS_GLOBALS` are reconciled
 * against a live sandbox probe by `core/pi-globals.test.ts`.
 */
export const PI_SANDBOX_BUILTINS: readonly string[] = [
  "performance",
  "atob",
  "btoa",
  "queueMicrotask",
  "escape",
  "unescape",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURI",
  "decodeURI",
  "encodeURIComponent",
  "decodeURIComponent",
  "eval",
  "console",
  // Engine/host extras QuickJS ships beyond ECMA-262.
  "DOMException",
  "InternalError",
];

/**
 * Ambient JavaScript globals the sandbox defines — the language half of the
 * skip vocabulary (`RESERVED_GLOBALS`) in `dialect/translate.ts`. Verified as
 * own properties of `globalThis` in the live sandbox. Deliberately contains NO
 * host/environment API: an absent one lives in `PI_SANDBOX_HOST_GLOBALS` below
 * and gets an `UNSUPPORTED_GLOBALS` row instead, so a catalog tool with a
 * colliding name still rewrites (and warns at most once). Reconciled against
 * a live sandbox probe by `core/pi-globals.test.ts`.
 */
export const JS_GLOBALS: readonly string[] = [
  "Array", "ArrayBuffer", "BigInt", "Boolean", "DataView", "Date", "Error", "EvalError",
  "FinalizationRegistry", "Float32Array", "Float64Array", "Infinity", "Int16Array", "Int32Array",
  "Int8Array", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy",
  "RangeError", "ReferenceError", "Reflect", "RegExp", "Set", "String", "Symbol", "SyntaxError",
  "TypeError", "URIError", "Uint16Array", "Uint32Array", "Uint8Array", "Uint8ClampedArray",
  "WeakMap", "WeakRef", "WeakSet", "globalThis", "undefined",
  // Newer editions, verified present in the sandbox's QuickJS.
  "AggregateError", "AsyncDisposableStack", "BigInt64Array", "BigUint64Array", "DisposableStack",
  "Float16Array", "Function", "Iterator", "SharedArrayBuffer", "SuppressedError",
];

/**
 * Host globals: APIs the environment provides rather than the ECMAScript
 * language (Web, Node, timers, storage — `Intl` included as the
 * normatively-optional ECMA-402 layer). Probed live with `typeof` on every
 * name below. Classification invariant, enforced by `dialect/signals.test.ts`:
 * each name is either in the present vocabulary (`PI_SANDBOX_GLOBALS` /
 * `PI_SANDBOX_BUILTINS`) or has an `UNSUPPORTED_GLOBALS` row — never both,
 * never neither. Adding a host name here makes the invariant test demand its
 * classification; adding an `UNSUPPORTED_GLOBALS` runtime row without listing
 * it here fails the reverse check.
 */
export const PI_SANDBOX_HOST_GLOBALS: readonly string[] = [
  // Present in the sandbox (own `globalThis` properties).
  "performance", "atob", "btoa", "queueMicrotask", "console",
  // Absent — each has a NON-distinctive `UNSUPPORTED_GLOBALS` row in
  // `dialect/signals.ts` (rows must never become a dialect signal).
  "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "Intl", "structuredClone", "TextEncoder", "TextDecoder",
  "URL", "URLSearchParams", "crypto", "fetch",
  "process", "require", "Buffer",
  "Atomics", "WebAssembly",
  "AbortController", "Blob", "Headers", "Request", "Response", "FormData",
  "localStorage", "window", "document", "navigator",
];
