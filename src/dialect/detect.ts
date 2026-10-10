// ---------------------------------------------------------------------------
// Dialect detection
// ---------------------------------------------------------------------------
//
// Codemode ships in several flavors. They all share the `{ code }` envelope,
// but the program API differs enough that the source must be detected before it
// can be compiled:
//
//   pi          — `tools.<identifier>`, `searchTools`, `ALL_TOOLS`, `@options`
//   opencode    — `tools.<ns>.<tool>`, `tools.$codemode.*`, `Object.keys(tools)`
//   cloudflare  — `codemode.<tool>`, `codemode.search/describe/run/step`, and an
//                 `async () => { ... }` wrapper as the whole program
//   tanstack    — bare `external_<tool>` bindings (TanStack AI code mode)
//   vercel      — TypeScript with `tools.<name>` / `tools["<name>"]` (Vercel AI SDK code mode)
//   ptc         — DeepSeek Harness PTC: arbitrary-string tool names in
//                 `tools["raw-name"]`, `Object.keys(tools)`, `ToolCallError`,
//                 and `await import(...)` (Node APIs) — `@deepseek-ai/dsh-ptc-runtime-node`
//   codex       — OpenAI Codex code mode: a `// @exec:` pragma and the
//                 Codex-only helpers (`yield_control`, `notify`,
//                 `generatedImage`, `audio`); tool calls are already Pi
//                 identifiers — `codex-rs/code-mode-runtime`
//
// Detection is deliberately lexical + shallow-AST only: it never rewrites, so a
// false positive is a wrong `details.dialect`, not a corrupted script.
//
// TanStack's source is TypeScript and often does not parse as JavaScript, so its
// signal is also checked lexically (a bare `external_<tool>` reference, never a
// `tools.external_<tool>` member access).

import { collectChain } from "../core/catalog.ts";
import { parseScript, walk, type AstNode } from "../core/parse.ts";
import { collectBoundNames, isDeclarationPosition } from "../core/scope.ts";
import { PI_LOOKUP_HELPERS } from "../core/pi-globals.ts";
import { stripComments } from "../core/lexical.ts";
import { CLOUDFLARE_PLATFORM_METHODS } from "../core/shims.ts";
import {
  DISTINCTIVE_UNSUPPORTED_BY_NAME,
  DISTINCTIVE_UNSUPPORTED_GLOBALS,
  TANSTACK_BINDING_PREFIX,
  unsupportedGlobalSignal,
  type CodemodeDialect,
} from "./signals.ts";

// Re-exported so `./dialect` (the public subpath) keeps exposing the type.
export type { CodemodeDialect } from "./signals.ts";

/** A bare `external_<tool>` reference (not `tools.external_<tool>`), for unparseable TypeScript. */
const TANSTACK_LEXICAL = /(^|[^.\w$])external_[A-Za-z0-9_$]+/;
/**
 * A bare `tools.<name>` / `tools["<name>"]` / `tools?.<name>` reference, for
 * unparseable TypeScript (Vercel). The accessor is required, so the bare word
 * `tools` in `toolset` or `"tools rock"` does not match.
 */
const VERCEL_LEXICAL = /\btools\s*(?:\?\.\s*(?:[A-Za-z_$]|\[)|\.\s*[A-Za-z_$]|\[)/;
/** An OpenCode-style nested `tools.<ns>.<tool>` path, for unparseable TypeScript. */
const OPENCODE_NESTED_LEXICAL = /\btools\.[A-Za-z_$][\w$]*\.[A-Za-z_$]/;
/** A Cloudflare `codemode.<tool>` / `codemode.search` platform call, for unparseable TypeScript. */
const CLOUDFLARE_LEXICAL = /\bcodemode\s*\./;
/** DeepSeek Harness PTC signals, for unparseable TypeScript. */
const PTC_IMPORT_LEXICAL = /\bimport\s*\(/;
const PTC_OBJECT_KEYS_LEXICAL = /\bObject\.keys\s*\(\s*tools\s*\)/;
/**
 * Distinctive unsupported globals (Codex helpers and PTC's `ToolCallError`),
 * for unparseable TypeScript. The name list comes from `signals.ts`.
 */
const DISTINCTIVE_UNSUPPORTED_LEXICAL = DISTINCTIVE_UNSUPPORTED_GLOBALS.map((entry) => ({
  entry,
  pattern: new RegExp(`\\b${entry.name}\\b`),
}));

/**
 * Cheap lexical check for a locally bound `tools`, used only when the script
 * does not parse (no AST to run `collectBoundNames` on). Best-effort: it looks
 * for declaration forms only (`const/let/var/function tools`, function
 * parameters, arrow parameters) so passing the global `tools` to a function
 * does not count.
 */
const LEXICAL_TOOLS_BINDING =
  /\b(?:const|let|var|function)\s+tools\b|\bfunction\s*[\w$]*\s*\(\s*tools\b|\(\s*tools\b[^)]*\)\s*=>/;

export interface DialectDetection {
  readonly dialect: CodemodeDialect;
  /** Why the dialect was chosen, e.g. `$codemode.search`, `codemode.<tool>`, `searchTools`. */
  readonly signals: readonly string[];
}

export interface DialectDetectionContext {
  /**
   * True when the source had a `// @options:` line that the caller stripped
   * before detection (compile.ts normalizes the options line first, so the
   * comment is no longer visible to the lexical signal check).
   */
  readonly hadOptionsLine?: boolean;
  /** Like {@link hadOptionsLine}, for Codex's `// @exec:` pragma. */
  readonly hadExecLine?: boolean;
}

/** Whether the whole script is a bare async arrow/function (Cloudflare's shape). */
function isAsyncArrowWrapper(ast: AstNode): boolean {
  const statements = (ast.body as AstNode[]).filter((statement) => statement.type !== "EmptyStatement");
  if (statements.length !== 1) return false;
  const statement = statements[0]!;
  if (statement.type !== "ExpressionStatement") return false;
  const expression = statement.expression as AstNode;
  return (
    (expression.type === "ArrowFunctionExpression" || expression.type === "FunctionExpression") &&
    expression.async === true
  );
}

/** Lexical + AST signals that identify the dialect of a script. */
export function detectCodemodeDialect(code: string, context: DialectDetectionContext = {}): DialectDetection {
  const signals = new Set<string>();

  if (/@options/i.test(code) || context.hadOptionsLine === true) signals.add("pi:@options");
  if (/@exec/i.test(code) || context.hadExecLine === true) signals.add("codex:@exec");

  const ast = parseScript(code);
  // A locally bound `tools` shadows the sandbox global: its namespace paths,
  // `$codemode` members, and `Object.keys(tools)` calls address the script's
  // own object, so none of them is an OpenCode signal. Pure and catalog-free:
  // this only reads the script's own bindings.
  const toolsBound = ast
    ? collectBoundNames(ast).has("tools")
    : LEXICAL_TOOLS_BINDING.test(stripComments(code));

  if (!toolsBound && code.includes("$codemode")) signals.add("$codemode");

  if (ast) {
    walk(ast, [], (node, parents) => {
      if (node.type === "MemberExpression") {
        const parent = parents[parents.length - 1];
        if (parent?.type === "MemberExpression" && parent.object === node) return;
        const chain = collectChain(node);
        if (chain?.root === "tools" && !toolsBound) {
          if (chain.segments[0] === "$codemode") {
            signals.add(chain.segments[1] === "search" ? "$codemode.search" : "$codemode.<member>");
          } else if (chain.segments.length >= 2) {
            signals.add("tools.<namespace>.<tool>");
          }
        }
        if (chain?.root === "codemode") {
          if (chain.segments.length >= 1) {
            const method = chain.segments[0]!;
            signals.add(CLOUDFLARE_PLATFORM_METHODS.has(method) ? `codemode.${method}` : "codemode.<tool>");
          }
        }
        if (chain?.root === "models" && chain.segments.length >= 1) signals.add("pi:models");
        return;
      }

      if (node.type === "ImportExpression") {
        // PTC exposes Node APIs via `await import(...)`; Pi's sandbox has none.
        signals.add("ptc:import()");
        return;
      }

      if (node.type === "Identifier") {
        const name = node.name as string;
        const unsupported = DISTINCTIVE_UNSUPPORTED_BY_NAME.get(name);
        if (unsupported) {
          const parent = parents[parents.length - 1];
          const isMemberProperty = parent?.type === "MemberExpression" && parent.property === node;
          if (!isMemberProperty && !isDeclarationPosition(node, parents)) signals.add(unsupportedGlobalSignal(unsupported));
        }
        if (name === "ALL_TOOLS") signals.add("pi:ALL_TOOLS");
        if ((PI_LOOKUP_HELPERS as readonly string[]).includes(name)) {
          signals.add(`pi:${name}`);
        }
        if (name.startsWith(TANSTACK_BINDING_PREFIX) && name.length > TANSTACK_BINDING_PREFIX.length) {
          const parent = parents[parents.length - 1];
          const isMemberProperty = parent?.type === "MemberExpression" && parent.property === node;
          if (!isMemberProperty && !isDeclarationPosition(node, parents)) signals.add("external_<tool>");
        }
        return;
      }

      if (node.type === "CallExpression") {
        const chain = collectChain(node.callee as AstNode);
        if (chain?.root === "Object" && chain.segments.join(".") === "keys") {
          const first = (node.arguments as AstNode[])[0];
          const target = first ? collectChain(first) : undefined;
          if (target?.root === "tools" && !toolsBound) {
            signals.add(target.segments.length === 0 ? "Object.keys(tools)" : "Object.keys(tools.<ns>)");
          }
        }
        if (chain?.root === "tools" && chain.segments[0] === "$codemode" && !toolsBound) {
          signals.add(chain.segments[1] === "search" ? "$codemode.search" : "$codemode.<member>");
        }
      }
    });

    if (isAsyncArrowWrapper(ast)) signals.add("async-arrow-wrapper");
  } else {
    // No AST (TypeScript does not parse as JavaScript): fall back to lexical
    // signals. Comments are blanked out first so a comment-only mention of a
    // dialect keyword does not misroute the script.
    const lexical = stripComments(code);
    if (TANSTACK_LEXICAL.test(lexical)) {
      // The distinctive bare `external_<tool>` binding name.
      signals.add("external_<tool>");
    } else if (!toolsBound && OPENCODE_NESTED_LEXICAL.test(lexical)) {
      // TypeScript that still uses OpenCode's nested `tools.<ns>.<tool>` paths.
      signals.add("tools.<namespace>.<tool>");
    } else if (CLOUDFLARE_LEXICAL.test(lexical)) {
      // TypeScript Cloudflare agents source still addresses the platform namespace.
      signals.add("codemode.<tool>");
    } else {
      // DeepSeek Harness PTC's signals, checked before the generic Vercel
      // fallback: its `ToolCallError` global, `await import(...)`, and
      // `Object.keys(tools)` discovery all survive as raw text in TypeScript.
      let ptc = false;
      for (const { entry, pattern } of DISTINCTIVE_UNSUPPORTED_LEXICAL) {
        if (!pattern.test(lexical)) continue;
        signals.add(unsupportedGlobalSignal(entry));
        if (entry.dialect === "ptc") ptc = true;
      }
      if (PTC_IMPORT_LEXICAL.test(lexical)) {
        signals.add("ptc:import()");
        ptc = true;
      }
      if (PTC_OBJECT_KEYS_LEXICAL.test(lexical)) {
        signals.add("ptc:Object.keys(tools)");
        ptc = true;
      }
      if (!ptc && VERCEL_LEXICAL.test(lexical)) {
        // TypeScript plus a `tools` reference and no other dialect's signal is the
        // Vercel AI SDK code mode shape (`js` field, `tools.<name>` calls).
        signals.add("vercel:tools.<name>");
      }
    }
  }

  const list = [...signals];

  // 1. OpenCode's structural signals always win.
  const structuralOpenCode = list.some(
    (signal) => signal.startsWith("$codemode") || signal === "tools.<namespace>.<tool>",
  );
  if (structuralOpenCode) return { dialect: "opencode", signals: list };

  // 2. `external_<tool>` is TanStack-specific, so it wins over the generic bare
  // async wrapper (a model may wrap TanStack code from Cloudflare habit).
  if (list.includes("external_<tool>")) return { dialect: "tanstack", signals: list };

  // 3. Cloudflare's platform namespace.
  if (list.some((signal) => signal.startsWith("codemode."))) return { dialect: "cloudflare", signals: list };

  // 4. PTC's specific signals (`ToolCallError`, `import()`) outrank the generic
  // `Object.keys(tools)` OpenCode shape, but lose to the structural shapes above.
  if (list.some((signal) => signal.startsWith("ptc:"))) return { dialect: "ptc", signals: list };

  // 5. The generic OpenCode tool-listing shape.
  if (list.some((signal) => signal.startsWith("Object.keys(tools"))) {
    return { dialect: "opencode", signals: list };
  }

  // 6. Vercel's TypeScript + `tools` reference fallback.
  if (list.includes("vercel:tools.<name>")) return { dialect: "vercel", signals: list };

  // 6.5. Codex's `@exec` pragma and its code-mode-only helpers. Checked before
  // Pi's own helpers because a Codex script also uses `ALL_TOOLS`/`models`.
  if (list.some((signal) => signal.startsWith("codex:"))) return { dialect: "codex", signals: list };

  // 7. Pi's own helpers and options.
  if (list.some((signal) => signal.startsWith("pi:"))) return { dialect: "pi", signals: list };

  // 8. A bare async wrapper is Cloudflare's program shape; Pi repairs it but it is
  // still a signal that the model was writing for Cloudflare.
  if (list.includes("async-arrow-wrapper")) return { dialect: "cloudflare", signals: list };

  return { dialect: "unknown", signals: list };
}