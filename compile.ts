// ---------------------------------------------------------------------------
// The codemode compiler
// ---------------------------------------------------------------------------
//
// `compileCodemodeSource` takes whatever JavaScript-ish text a model put in
// `code` and returns the script pi's codemode sandbox expects. Passes run in a
// fixed order, each independent and best-effort:
//
//   1. strip-code-fence          — remove ``` / ~~~ wrappers and surrounding prose
//   2. normalize-options-line    — rewrite the first `// @options:` line to strict JSON
//   3. compile-json-program      — turn JSON tool calls into `await tools.*` calls
//   4. tanstack-typescript       — strip TypeScript syntax (TanStack code mode)
//   5. vercel-typescript         — strip TypeScript syntax (Vercel AI SDK code mode)
//   6. ptc-typescript            — strip TypeScript syntax (DeepSeek Harness PTC)
//   7. strip-typescript          — generic TypeScript fallback: no dialect claimed the
//                                  script and acorn cannot parse it
//   8. unwrap-iife               — drop a redundant async IIFE wrapper
//   9. opencode-dialect          — translate OpenCode codemode paths/search to Pi
//  10. cloudflare-dialect        — translate Cloudflare agents codemode namespaces to Pi
//  11. tanstack-dialect          — translate TanStack `external_<tool>` bindings to Pi
//  12. vercel-dialect            — translate Vercel `tools["<raw-name>"]` access to Pi
//  13. ptc-dialect               — translate DeepSeek Harness PTC `tools["<raw-name>"]` / `Object.keys(tools)` to Pi
//  14. await-async-calls         — add the `await` models forget (pi issue #10555)
//  15. rewrite-tool-identifiers  — `tools["a-b"]` -> `tools.a_b`
//
// A JSON program (pass 3) is compiler-generated JavaScript: it skips the
// parse-dependent dialect passes (4–13) and runs only 14–15 on the result, so
// raw-JavaScript string steps still get awaited and rewritten.
//
// A pass that would need a parse is skipped when the script does not parse, so
// a guard bug can never corrupt a script beyond what lexical passes already did.

import { injectAwait } from "./await-inject.ts";
import { compileCloudflareDialect } from "./cloudflare.ts";
import { detectCodemodeDialect, type CodemodeDialect } from "./dialect.ts";
import { stripCodeFences } from "./fences.ts";
import { unwrapIIFE } from "./iife.ts";
import { splitOptionsLine } from "./options.ts";
import { compileOpencodeDialect } from "./opencode.ts";
import { compilePtcDialect } from "./ptc.ts";
import { looksLikeToolProgram, programToJs } from "./program.ts";
import { parseScript } from "./parse.ts";
import { rewriteToolIdentifiers } from "./rewrite.ts";
import { compileTanstackDialect } from "./tanstack.ts";
import { stripTypeScriptSyntax } from "./typescript.ts";
import { compileVercelDialect } from "./vercel.ts";

export interface CompileOptions {
  /**
   * Pi tool names, from `pi.getAllTools()`. Used to resolve OpenCode namespace
   * paths (`tools.orders.lookup`), TanStack bindings (`external_getWeather`),
   * and Vercel/PTC raw names (`tools["web-search"]`) to Pi's flat identifiers.
   */
  readonly tools?: readonly string[];
}

export interface CompileResult {
  /** The script to hand to the codemode sandbox. */
  readonly code: string;
  /** Whether anything changed. */
  readonly changed: boolean;
  /**
   * Pass ids that applied, in order. May be non-empty even when `changed` is
   * false: a pass can run and reproduce the input verbatim (a canonical
   * `// @options:` line reports `normalize-options-line` without changing).
   * Empty together with `changed: false` means the script was already valid.
   */
  readonly passes: readonly string[];
  /** Whether the script was parsed (or recognized as a JSON program). */
  readonly parsed: boolean;
  /** The dialect the input was written in. */
  readonly dialect: CodemodeDialect;
  /** Non-fatal problems, e.g. an `@options` line that had to be dropped. */
  readonly warnings: readonly string[];
}

function looksLikeJson(text: string): boolean {
  return text.startsWith("{") || text.startsWith("[");
}

/**
 * Compile model-written codemode source into pi's codemode syntax.
 *
 * Pure and deterministic: no I/O. `options.tools` is only a name list, so the
 * function stays trivially testable.
 */
export function compileCodemodeSource(input: string, options: CompileOptions = {}): CompileResult {
  const passes: string[] = [];
  const warnings: string[] = [];
  let parsed = false;
  let dialect: CodemodeDialect = "unknown";

  const fenced = stripCodeFences(input);
  let code = fenced.code;
  if (fenced.changed) {
    passes.push("strip-code-fence");
    warnings.push(...fenced.warnings);
    if (code.trim() === "") {
      // The fences module reports only *how* it stripped; whether the script
      // then vanished entirely is visible only here.
      warnings.push("removed an empty code fence; the script is empty");
    }
  }

  const optionsLine = splitOptionsLine(code);
  if (optionsLine.changed) {
    passes.push("normalize-options-line");
    warnings.push(...optionsLine.warnings);
  }
  let body = optionsLine.body;

  const trimmed = body.trim();
  if (looksLikeJson(trimmed)) {
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (looksLikeToolProgram(value)) {
        body = programToJs(Array.isArray(value) ? value : [value]);
        passes.push("compile-json-program");
        parsed = true;
        // A JSON program is not written in any JavaScript dialect, so `dialect`
        // stays "unknown": the generated script is pi-native (`tools.<id>`) and
        // needs no dialect detection or translation. `parsed` stays true — the
        // source was recognized (as a JSON tool-call program) and compiled.
        // String steps are raw JS emitted verbatim, so the compiler-generated
        // script still gets the await repair (pi #10555) and identifier rewrite;
        // otherwise `compile(compile(x)) !== compile(x)` on those steps.
        const awaited = injectAwait(body);
        if (awaited === undefined) {
          warnings.push("could not parse a raw-JavaScript step in the JSON program; skipped await and identifier passes");
        } else {
          if (awaited.inserted > 0) {
            body = awaited.code;
            passes.push(`await-async-calls(${awaited.inserted})`);
          }
          const rewritten = rewriteToolIdentifiers(body, options.tools);
          if (rewritten?.changed) {
            body = rewritten.code;
            passes.push("rewrite-tool-identifiers");
          }
        }
      }
    } catch {
      // Not JSON after all; fall through to the JavaScript passes.
    }
  }

  if (!parsed) {
    // Detect before unwrapping: Cloudflare's `async () => { ... }` wrapper is
    // itself a dialect signal, so it must be seen before `unwrap-iife` strips it.
    // `hadOptionsLine` restores the `@options` signal the pass-2 split removed.
    dialect = detectCodemodeDialect(body, { hadOptionsLine: optionsLine.changed }).dialect;

    // TanStack source is TypeScript, so it must be stripped before `unwrap-iife`
    // (or any other acorn pass) can parse it.
    if (dialect === "tanstack") {
      const stripped = stripTypeScriptSyntax(body);
      warnings.push(...stripped.warnings);
      if (stripped.changed) {
        body = stripped.code;
        passes.push("tanstack-typescript");
      }
    } else if (dialect === "vercel") {
      const stripped = stripTypeScriptSyntax(body);
      warnings.push(...stripped.warnings);
      if (stripped.changed) {
        body = stripped.code;
        passes.push("vercel-typescript");
      }
    } else if (dialect === "ptc") {
      const stripped = stripTypeScriptSyntax(body);
      warnings.push(...stripped.warnings);
      if (stripped.changed) {
        body = stripped.code;
        passes.push("ptc-typescript");
      }
    } else if (dialect === "unknown" && parseScript(body) === undefined) {
      // Generic TypeScript fallback: no dialect claimed the script and acorn
      // cannot parse it, so it may be plain TypeScript (`const x: number = 1`).
      // Best-effort: only a successful strip changes anything; if sucrase fails
      // too, its warning is recorded and the pipeline keeps the existing
      // behavior for an unparseable script (unchanged + warning downstream).
      // Never runs when a dialect TypeScript pass above already ran.
      const stripped = stripTypeScriptSyntax(body);
      warnings.push(...stripped.warnings);
      if (stripped.changed) {
        body = stripped.code;
        passes.push("strip-typescript");
        // The stripped JavaScript may now show dialect signals the TS syntax hid.
        dialect = detectCodemodeDialect(body, { hadOptionsLine: optionsLine.changed }).dialect;
      }
    }

    const iife = unwrapIIFE(body);
    if (iife.changed) {
      body = iife.code;
      passes.push("unwrap-iife");
    }

    if (dialect === "opencode") {
      const opencode = compileOpencodeDialect(body, options);
      // Push unconditionally: the pass can warn without changing anything
      // (e.g. an unsupported `$codemode.describe`), and every other dialect
      // reports its warnings outside the `changed` check.
      warnings.push(...opencode.warnings);
      if (opencode.changed) {
        body = opencode.code;
        passes.push(`opencode-dialect(${opencode.rewrites})`);
      }
    } else if (dialect === "cloudflare") {
      const cloudflare = compileCloudflareDialect(body, options);
      warnings.push(...cloudflare.warnings);
      if (cloudflare.changed) {
        body = cloudflare.code;
        passes.push(`cloudflare-dialect(${cloudflare.rewrites})`);
      }
    } else if (dialect === "tanstack") {
      const tanstack = compileTanstackDialect(body, options);
      warnings.push(...tanstack.warnings);
      if (tanstack.changed) {
        body = tanstack.code;
        passes.push(`tanstack-dialect(${tanstack.rewrites})`);
      }
    } else if (dialect === "vercel") {
      const vercel = compileVercelDialect(body, options);
      warnings.push(...vercel.warnings);
      if (vercel.changed) {
        body = vercel.code;
        passes.push(`vercel-dialect(${vercel.rewrites})`);
      }
    } else if (dialect === "ptc") {
      const ptc = compilePtcDialect(body, options);
      warnings.push(...ptc.warnings);
      if (ptc.changed) {
        body = ptc.code;
        passes.push(`ptc-dialect(${ptc.rewrites})`);
      }
    }

    const awaited = injectAwait(body);
    if (awaited) {
      parsed = true;
      if (awaited.inserted > 0) {
        body = awaited.code;
        passes.push(`await-async-calls(${awaited.inserted})`);
      }
      const rewritten = rewriteToolIdentifiers(body, options.tools);
      if (rewritten?.changed) {
        body = rewritten.code;
        passes.push("rewrite-tool-identifiers");
      }
    } else {
      warnings.push("could not parse the script as JavaScript; skipped await and identifier passes");
    }
  }

  code = optionsLine.optionsLine !== undefined ? `${optionsLine.optionsLine}\n${body}` : body;
  return { code, changed: code !== input, passes, parsed, dialect, warnings };
}
