// ---------------------------------------------------------------------------
// The codemode compiler
// ---------------------------------------------------------------------------
//
// `compileCodemodeSource` takes whatever JavaScript-ish text a model put in
// `code` and returns the script pi's codemode sandbox expects.
//
// The compiler is statement-based: after the lexical/preamble passes it hands
// the whole script to `translateCodemode`, which parses once and translates each
// construct by its shape. A snippet may mix dialects — an OpenCode namespace path
// next to a Vercel bracket call next to a bare `search(...)` — and every
// construct is repaired, instead of only the one dialect detected for the whole
// snippet. Dialect detection is still used to pick the TypeScript-stripping pass
// and to disambiguate the two constructs OpenCode and PTC genuinely share.
//
// Passes, each independent and best-effort:
//
//   1. strip-code-fence          — remove ``` / ~~~ wrappers and surrounding prose
//   2. normalize-options-line    — rewrite `// @options:` / Codex's `// @exec:`
//                                  line to strict JSON
//   3. compile-json-program      — turn JSON tool calls into `await tools.*` calls
//   4. <dialect>-typescript      — strip TypeScript syntax (TanStack / Vercel /
//                                  PTC code mode); `strip-typescript` is the
//                                  generic fallback when no dialect claimed it
//   5. unwrap-iife               — drop a redundant async IIFE wrapper
//   6. translate-statements      — one statement-based pass over every dialect
//                                  construct (OpenCode, Cloudflare, TanStack,
//                                  Vercel, PTC, Codex) plus bare tool calls
//   7. await-async-calls         — add the `await` models forget (pi #10555)
//   8. rewrite-tool-identifiers  — `tools["a-b"]` -> `tools.a_b`
//
// A JSON program (pass 3) is compiler-generated JavaScript: it skips passes 4–6
// and runs only 7–8 on the result, so raw-JavaScript string steps still get
// awaited and rewritten.
//
// A pass that would need a parse is skipped when the script does not parse, so
// a guard bug can never corrupt a script beyond what lexical passes already did.

import { injectAwait } from "./await-inject.ts";
import { detectCodemodeDialect, type CodemodeDialect } from "./dialect.ts";
import { stripCodeFences } from "./fences.ts";
import { unwrapIIFE } from "./iife.ts";
import { splitOptionsLine } from "./options.ts";
import { looksLikeToolProgram, programToJs } from "./program.ts";
import { parseScript } from "./parse.ts";
import { rewriteToolIdentifiers } from "./rewrite.ts";
import { translateCodemode, type TranslateGroup } from "./translate.ts";
import { stripTypeScriptSyntax } from "./typescript.ts";

export interface CompileOptions {
  /**
   * Pi tool names, from `pi.getAllTools()`. Used to resolve OpenCode namespace
   * paths (`tools.orders.lookup`), TanStack bindings (`external_getWeather`),
   * Vercel/PTC raw names (`tools["web-search"]`), and bare tool calls
   * (`search(...)`) to Pi's flat identifiers.
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

/** Pass id for each translation group, in the order groups are reported. */
const GROUP_PASSES: ReadonlyArray<readonly [TranslateGroup, string]> = [
  ["opencode", "opencode-dialect"],
  ["cloudflare", "cloudflare-dialect"],
  ["tanstack", "tanstack-dialect"],
  ["vercel", "vercel-dialect"],
  ["ptc", "ptc-dialect"],
  ["codex", "codex-dialect"],
  ["bare", "bare-tool-calls"],
];

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
        // needs no statement translation. `parsed` stays true — the source was
        // recognized (as a JSON tool-call program) and compiled. String steps are
        // raw JS emitted verbatim, so the compiler-generated script still gets
        // the await repair (pi #10555) and identifier rewrite; otherwise
        // `compile(compile(x)) !== compile(x)` on those steps.
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
    // `hadOptionsLine`/`hadExecLine` restore the pragma signals pass 2 removed.
    dialect = detectCodemodeDialect(body, {
      hadOptionsLine: optionsLine.directive === "options",
      hadExecLine: optionsLine.directive === "exec",
    }).dialect;

    // TanStack/Vercel/PTC source is TypeScript, so it must be stripped before
    // `unwrap-iife` (or any other acorn pass) can parse it.
    if (dialect === "tanstack" || dialect === "vercel" || dialect === "ptc") {
      const stripped = stripTypeScriptSyntax(body);
      warnings.push(...stripped.warnings);
      if (stripped.changed) {
        body = stripped.code;
        passes.push(`${dialect}-typescript`);
      }
    } else if (dialect === "unknown" && parseScript(body) === undefined) {
      // Generic TypeScript fallback: no dialect claimed the script and acorn
      // cannot parse it, so it may be plain TypeScript (`const x: number = 1`).
      // Best-effort: only a successful strip changes anything; if sucrase fails
      // too, its warning is recorded and the pipeline keeps the existing
      // behavior for an unparseable script (unchanged + warning downstream).
      const stripped = stripTypeScriptSyntax(body);
      warnings.push(...stripped.warnings);
      if (stripped.changed) {
        body = stripped.code;
        passes.push("strip-typescript");
        // The stripped JavaScript may now show dialect signals the TS syntax hid.
        dialect = detectCodemodeDialect(body, {
          hadOptionsLine: optionsLine.directive === "options",
          hadExecLine: optionsLine.directive === "exec",
        }).dialect;
      }
    }

    const iife = unwrapIIFE(body);
    if (iife.changed) {
      body = iife.code;
      passes.push("unwrap-iife");
    }

    // Statement-based translation: every construct, in every dialect, by shape.
    const translated = translateCodemode(body, { tools: options.tools, dialect });
    warnings.push(...translated.warnings);
    if (translated.changed) {
      body = translated.code;
      passes.push("translate-statements");
      for (const [group, pass] of GROUP_PASSES) {
        const count = translated.groups[group];
        if (count !== undefined && count > 0) passes.push(`${pass}(${count})`);
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
