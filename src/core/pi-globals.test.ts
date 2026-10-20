// ---------------------------------------------------------------------------
// Sandbox vocabulary reconciliation (live probe)
// ---------------------------------------------------------------------------
//
// `core/pi-globals.ts` classifies every identifier Pi's codemode sandbox
// provides (`PI_SANDBOX_GLOBALS`, `PI_SANDBOX_BUILTINS`, `JS_GLOBALS`) and
// `dialect/signals.ts` lists the globals it lacks (`UNSUPPORTED_GLOBALS`).
// The tables are hand-maintained history; this test is the ground truth. It
// runs `Object.getOwnPropertyNames(globalThis)` inside Pi's real QuickJS
// sandbox — the same `executeCodemode` the codemode tool uses — and fails
// whenever the vocabulary drifts from the sandbox: a QuickJS upgrade adding a
// builtin, or Pi gaining an API the table still calls absent.
//
// The deep import bypasses Pi's package `exports` map (only `.` is exported)
// by locating the package on disk and importing the file URL directly.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { UNSUPPORTED_GLOBALS } from "../dialect/signals.ts";
import { JS_GLOBALS, PI_SANDBOX_BUILTINS, PI_SANDBOX_GLOBALS } from "./pi-globals.ts";

/**
 * Injected only when the session has a model registry (`options.models && ctx`
 * in pi's `executeCodemode`), so a ctx-less probe never sees it.
 */
const CONDITIONALLY_INJECTED = new Set(["models"]);

/** Locate Pi's package root: the resolved entry is `<root>/dist/index.js`. */
function piPackageRoot(): string {
  const candidates: string[] = [];
  try {
    const resolved: unknown = import.meta.resolve("@earendil-works/pi-coding-agent");
    if (typeof resolved === "string" && resolved.startsWith("file:")) {
      candidates.push(dirname(dirname(fileURLToPath(resolved))));
    }
  } catch {
    // No `import.meta.resolve` in this runner — fall through to disk.
  }
  // `src/core/..` is the package root (a direct devDependency, so the symlink
  // exists under `node_modules`), and the working directory is the same root.
  candidates.push(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "@earendil-works", "pi-coding-agent"));
  candidates.push(join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent"));

  const root = candidates.find((candidate) => existsSync(join(candidate, "dist")));
  if (!root) {
    throw new Error(
      `Could not locate the @earendil-works/pi-coding-agent package (tried: ${candidates.join(", ")}). ` +
        "The live sandbox probe needs the installed Pi package on disk.",
    );
  }
  return root;
}

/** Run `Object.getOwnPropertyNames(globalThis)` in Pi's real QuickJS sandbox. */
async function sandboxGlobalThis(): Promise<Set<string>> {
  const executeJs = join(piPackageRoot(), "dist", "extensions", "codemode", "execute.js");
  if (!existsSync(executeJs)) {
    throw new Error(
      `Pi's codemode sandbox module moved: ${executeJs} does not exist. ` +
        "Update this probe and reconcile core/pi-globals.ts / dialect/signals.ts against the new layout.",
    );
  }
  const module = (await import(pathToFileURL(executeJs).href)) as {
    executeCodemode: (
      toolCallId: string,
      input: { code: string },
      signal: undefined,
      onUpdate: undefined,
      ctx: null,
      options: Record<string, never>,
    ) => Promise<{ content: Array<{ text?: string }> }>;
  };
  const result = await module.executeCodemode(
    "pi-globals-probe",
    { code: "text(JSON.stringify(Object.getOwnPropertyNames(globalThis)));" },
    undefined,
    undefined,
    null,
    {},
  );
  const json = /\[[\s\S]*\]/.exec((result.content ?? []).map((item) => item.text ?? "").join(""))?.[0];
  if (!json) throw new Error(`Unexpected sandbox probe output: ${JSON.stringify(result.content)}`);
  return new Set(JSON.parse(json) as string[]);
}

describe("sandbox vocabulary vs the live QuickJS sandbox", () => {
  it(
    "classifies every sandbox global and claims no global the sandbox lacks",
    async () => {
      const sandbox = await sandboxGlobalThis();
      const present = new Set<string>([...JS_GLOBALS, ...PI_SANDBOX_BUILTINS, ...PI_SANDBOX_GLOBALS]);

      // A sandbox global the tables do not know: translator skip decisions
      // would treat it as an ordinary identifier. Add it to pi-globals.ts.
      const unclassified = [...sandbox].filter((name) => !present.has(name)).sort();
      expect(unclassified, "sandbox globals missing from the present vocabulary in core/pi-globals.ts").toEqual([]);

      // A table entry the sandbox does not provide: the tables claim "verified
      // present", so either pi changed or the entry moved to an
      // UNSUPPORTED_GLOBALS row.
      const overClaimed = [...present]
        .filter((name) => !sandbox.has(name) && !CONDITIONALLY_INJECTED.has(name))
        .sort();
      expect(overClaimed, "vocabulary names absent from the live sandbox").toEqual([]);

      // An absent-global warning for an API the sandbox now provides.
      const nowPresent = UNSUPPORTED_GLOBALS.map((row) => row.name)
        .filter((name) => sandbox.has(name))
        .sort();
      expect(nowPresent, "UNSUPPORTED_GLOBALS rows for globals the sandbox now provides").toEqual([]);
    },
    60_000,
  );
});
