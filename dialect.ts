// ---------------------------------------------------------------------------
// Dialect detection
// ---------------------------------------------------------------------------
//
// Codemode ships in several flavors. They all share the `{ code }` envelope,
// but the program API differs enough that the source must be detected before it
// can be compiled:
//
//   pi          — `tools.<identifier>`, `searchTools`, `ALL_TOOLS`, `@options`
//   opencode    — `tools.<ns>.<tool>`, `tools.$codemode.search`, `Object.keys(tools)`
//   cloudflare  — `codemode.<tool>`, `codemode.search/describe/run/step`, and an
//                 `async () => { ... }` wrapper as the whole program
//   tanstack    — bare `external_<tool>` bindings (TanStack AI code mode)
//   vercel      — TypeScript with `tools.<name>` / `tools["<name>"]` (Vercel AI SDK code mode)
//   ptc         — DeepSeek Harness PTC: arbitrary-string tool names in
//                 `tools["raw-name"]`, `Object.keys(tools)`, `ToolCallError`,
//                 and `await import(...)` (Node APIs) — `@deepseek-ai/dsh-ptc-runtime-node`
//
// Detection is deliberately lexical + shallow-AST only: it never rewrites, so a
// false positive is a wrong `details.dialect`, not a corrupted script.
//
// TanStack's source is TypeScript and often does not parse as JavaScript, so its
// signal is also checked lexically (a bare `external_<tool>` reference, never a
// `tools.external_<tool>` member access).

import { collectChain, walk } from "./catalog.ts";
import { parseScript, type AstNode } from "./parse.ts";

export type CodemodeDialect = "pi" | "opencode" | "cloudflare" | "tanstack" | "vercel" | "ptc" | "unknown";

const TANSTACK_PREFIX = "external_";
/** A bare `external_<tool>` reference (not `tools.external_<tool>`), for unparseable TypeScript. */
const TANSTACK_LEXICAL = /(^|[^.\w$])external_[A-Za-z0-9_$]+/;
/** A bare `tools.<name>` / `tools["<name>"]` / `tools?.<name>` reference, for unparseable TypeScript (Vercel). */
const VERCEL_LEXICAL = /\btools\s*(?:\?\.|\.)?\s*(?:[A-Za-z_$]|\[)/;
/** An OpenCode-style nested `tools.<ns>.<tool>` path, for unparseable TypeScript. */
const OPENCODE_NESTED_LEXICAL = /\btools\.[A-Za-z_$][\w$]*\.[A-Za-z_$]/;
/** A Cloudflare `codemode.<tool>` / `codemode.search` platform call, for unparseable TypeScript. */
const CLOUDFLARE_LEXICAL = /\bcodemode\s*\./;
/** DeepSeek Harness PTC signals, for unparseable TypeScript. */
const PTC_TOOL_CALL_ERROR_LEXICAL = /\bToolCallError\b/;
const PTC_IMPORT_LEXICAL = /\bimport\s*\(/;
const PTC_OBJECT_KEYS_LEXICAL = /\bObject\.keys\s*\(\s*tools\s*\)/;

export interface DialectDetection {
  readonly dialect: CodemodeDialect;
  /** Why the dialect was chosen, e.g. `$codemode.search`, `codemode.<tool>`, `searchTools`. */
  readonly signals: readonly string[];
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

/** Lexical + AST signals that identify the dialect of a script. */
export function detectCodemodeDialect(code: string): DialectDetection {
  const signals = new Set<string>();

  if (code.includes("$codemode")) signals.add("$codemode");
  if (/@options/i.test(code)) signals.add("pi:@options");

  const ast = parseScript(code);
  if (ast) {
    walk(ast, [], (node, parents) => {
      if (node.type === "MemberExpression") {
        const parent = parents[parents.length - 1];
        if (parent?.type === "MemberExpression" && parent.object === node) return;
        const chain = collectChain(node);
        if (chain?.root === "tools") {
          if (chain.segments[0] === "$codemode") signals.add("$codemode.search");
          else if (chain.segments.length >= 2) signals.add("tools.<namespace>.<tool>");
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
        if (name === "ALL_TOOLS") signals.add("pi:ALL_TOOLS");
        if (name === "searchTools" || name === "describeTool" || name === "describeNamespace") {
          signals.add(`pi:${name}`);
        }
        if (name.startsWith(TANSTACK_PREFIX) && name.length > TANSTACK_PREFIX.length) {
          const parent = parents[parents.length - 1];
          const isMemberProperty = parent?.type === "MemberExpression" && parent.property === node;
          const isDeclaration =
            (parent?.type === "VariableDeclarator" && parent.id === node) ||
            (parent?.type === "FunctionDeclaration" && parent.id === node);
          if (!isMemberProperty && !isDeclaration) signals.add("external_<tool>");
        }
        return;
      }

      if (node.type === "CallExpression") {
        const chain = collectChain(node.callee as AstNode);
        if (chain?.root === "Object" && chain.segments.join(".") === "keys") {
          const first = (node.arguments as AstNode[])[0];
          const target = first ? collectChain(first) : undefined;
          if (target?.root === "tools") {
            signals.add(target.segments.length === 0 ? "Object.keys(tools)" : "Object.keys(tools.<ns>)");
          }
        }
        if (chain?.root === "tools" && chain.segments[0] === "$codemode") signals.add("$codemode.search");
      }
    });

    if (isAsyncArrowWrapper(ast)) signals.add("async-arrow-wrapper");
  } else if (TANSTACK_LEXICAL.test(code)) {
    // No AST (TypeScript does not parse as JavaScript): fall back to the
    // distinctive bare `external_<tool>` binding name.
    signals.add("external_<tool>");
  } else if (OPENCODE_NESTED_LEXICAL.test(code)) {
    // TypeScript that still uses OpenCode's nested `tools.<ns>.<tool>` paths.
    signals.add("tools.<namespace>.<tool>");
  } else if (CLOUDFLARE_LEXICAL.test(code)) {
    // TypeScript Cloudflare agents source still addresses the platform namespace.
    signals.add("codemode.<tool>");
  } else {
    // DeepSeek Harness PTC's signals, checked before the generic Vercel
    // fallback: its `ToolCallError` global, `await import(...)`, and
    // `Object.keys(tools)` discovery all survive as raw text in TypeScript.
    let ptc = false;
    if (PTC_TOOL_CALL_ERROR_LEXICAL.test(code)) {
      signals.add("ptc:ToolCallError");
      ptc = true;
    }
    if (PTC_IMPORT_LEXICAL.test(code)) {
      signals.add("ptc:import()");
      ptc = true;
    }
    if (PTC_OBJECT_KEYS_LEXICAL.test(code)) {
      signals.add("ptc:Object.keys(tools)");
      ptc = true;
    }
    if (!ptc && VERCEL_LEXICAL.test(code)) {
      // TypeScript plus a `tools` reference and no other dialect's signal is the
      // Vercel AI SDK code mode shape (`js` field, `tools.<name>` calls).
      signals.add("vercel:tools.<name>");
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

  // 7. Pi's own helpers and options.
  if (list.some((signal) => signal.startsWith("pi:"))) return { dialect: "pi", signals: list };

  // 8. A bare async wrapper is Cloudflare's program shape; Pi repairs it but it is
  // still a signal that the model was writing for Cloudflare.
  if (list.includes("async-arrow-wrapper")) return { dialect: "cloudflare", signals: list };

  return { dialect: "unknown", signals: list };
}