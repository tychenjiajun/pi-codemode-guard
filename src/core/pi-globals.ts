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
  "structuredClone",
  "queueMicrotask",
];
