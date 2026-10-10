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

import { collectBoundNames, collectChain, walk } from "./catalog.ts";
import { parseScript, type AstNode } from "./parse.ts";

export type CodemodeDialect = "pi" | "opencode" | "cloudflare" | "tanstack" | "vercel" | "ptc" | "codex" | "unknown";

const TANSTACK_PREFIX = "external_";
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
const PTC_TOOL_CALL_ERROR_LEXICAL = /\bToolCallError\b/;
const PTC_IMPORT_LEXICAL = /\bimport\s*\(/;
const PTC_OBJECT_KEYS_LEXICAL = /\bObject\.keys\s*\(\s*tools\s*\)/;
/** Codex-only helper names (also survive as raw text in unparseable TypeScript). */
const CODEX_HELPER_LEXICAL = /\b(?:yield_control|generatedImage|notify|audio)\b/;
/**
 * Cheap lexical check for a locally bound `tools`, used only when the script
 * does not parse (no AST to run `collectBoundNames` on). Best-effort: it looks
 * for declaration forms only (`const/let/var/function tools`, function
 * parameters, arrow parameters) so passing the global `tools` to a function
 * does not count.
 */
const LEXICAL_TOOLS_BINDING =
  /\b(?:const|let|var|function)\s+tools\b|\bfunction\s*[\w$]*\s*\(\s*tools\b|\(\s*tools\b[^)]*\)\s*=>/;

/**
 * Blank out `//` and `/* … *​/` comments (newlines preserved, string literals
 * left alone) so a comment-only mention of a dialect keyword is not a signal.
 */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let quote = "";
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (quote !== "") {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < text.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

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

const CODEMODE_PLATFORM_METHODS = new Set(["search", "describe", "run", "step"]);

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

/** Whether `node` sits inside `container`'s source range. */
function within(node: AstNode, container: AstNode | undefined | null): boolean {
  if (!container) return false;
  return node.start >= container.start && node.end <= container.end;
}

/**
 * Whether the identifier is written in a declaration position — a variable or
 * function/class name, a function or catch parameter, or a property key — so
 * it is not a TanStack binding reference.
 */
function isDeclarationPosition(node: AstNode, parents: readonly AstNode[]): boolean {
  const parent = parents[parents.length - 1];
  if (!parent) return false;
  if (parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") {
    if (parent.key === node) return true;
  }
  for (let i = parents.length - 1; i >= 0; i--) {
    const ancestor = parents[i]!;
    if (ancestor.type === "VariableDeclarator" && within(node, ancestor.id as AstNode | undefined)) return true;
    if (ancestor.type === "FunctionDeclaration" && within(node, ancestor.id as AstNode | undefined)) return true;
    if (ancestor.type === "ClassDeclaration" && within(node, ancestor.id as AstNode | undefined)) return true;
    if (ancestor.type === "CatchClause" && within(node, ancestor.param as AstNode | undefined)) return true;
    if (
      ancestor.type === "FunctionDeclaration" ||
      ancestor.type === "FunctionExpression" ||
      ancestor.type === "ArrowFunctionExpression"
    ) {
      if ((ancestor.params as AstNode[]).some((param) => within(node, param))) return true;
    }
  }
  return false;
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
            signals.add(CODEMODE_PLATFORM_METHODS.has(method) ? `codemode.${method}` : "codemode.<tool>");
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
        if (name === "ToolCallError") signals.add("ptc:ToolCallError");
        if (name === "yield_control" || name === "generatedImage" || name === "notify" || name === "audio") {
          const parent = parents[parents.length - 1];
          const isMemberProperty = parent?.type === "MemberExpression" && parent.property === node;
          if (!isMemberProperty && !isDeclarationPosition(node, parents)) signals.add(`codex:${name}`);
        }
        if (name === "ALL_TOOLS") signals.add("pi:ALL_TOOLS");
        if (name === "searchTools" || name === "describeTool" || name === "describeNamespace") {
          signals.add(`pi:${name}`);
        }
        if (name.startsWith(TANSTACK_PREFIX) && name.length > TANSTACK_PREFIX.length) {
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
      if (PTC_TOOL_CALL_ERROR_LEXICAL.test(lexical)) {
        signals.add("ptc:ToolCallError");
        ptc = true;
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
      if (CODEX_HELPER_LEXICAL.test(lexical)) {
        signals.add("codex:helper");
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