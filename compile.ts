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
//   4. unwrap-iife               — drop a redundant async IIFE wrapper
//   5. opencode-dialect          — translate OpenCode codemode paths/search to Pi
//   6. await-async-calls         — add the `await` models forget (pi issue #10555)
//   7. rewrite-tool-identifiers  — `tools["a-b"]` -> `tools.a_b`
//
// A pass that would need a parse is skipped when the script does not parse, so
// a guard bug can never corrupt a script beyond what lexical passes already did.

import { injectAwait } from "./await-inject.ts";
import { stripCodeFences } from "./fences.ts";
import { unwrapIIFE } from "./iife.ts";
import { splitOptionsLine } from "./options.ts";
import {
  compileOpencodeDialect,
  detectCodemodeDialect,
  type CodemodeDialect,
} from "./opencode.ts";
import { looksLikeToolProgram, programToJs } from "./program.ts";
import { rewriteToolIdentifiers } from "./rewrite.ts";

export interface CompileOptions {
  /**
   * Pi tool names, from `pi.getAllTools()`. Used to resolve OpenCode namespace
   * paths (`tools.orders.lookup`) to Pi's flat identifiers.
   */
  readonly tools?: readonly string[];
}

export interface CompileResult {
  /** The script to hand to the codemode sandbox. */
  readonly code: string;
  /** Whether anything changed. */
  readonly changed: boolean;
  /** Pass ids that applied, in order. Empty means the script was already valid. */
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
      }
    } catch {
      // Not JSON after all; fall through to the JavaScript passes.
    }
  }

  if (!parsed) {
    const iife = unwrapIIFE(body);
    if (iife.changed) {
      body = iife.code;
      passes.push("unwrap-iife");
    }

    const detection = detectCodemodeDialect(body);
    dialect = detection.dialect;
    if (dialect === "opencode") {
      const opencode = compileOpencodeDialect(body, options);
      if (opencode.changed) {
        body = opencode.code;
        passes.push(`opencode-dialect(${opencode.rewrites})`);
        warnings.push(...opencode.warnings);
      }
    }

    const awaited = injectAwait(body);
    if (awaited) {
      parsed = true;
      if (awaited.inserted > 0) {
        body = awaited.code;
        passes.push(`await-async-calls(${awaited.inserted})`);
      }
      const rewritten = rewriteToolIdentifiers(body);
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
