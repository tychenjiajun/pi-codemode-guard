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
//
// Detection is deliberately lexical + shallow-AST only: it never rewrites, so a
// false positive is a wrong `details.dialect`, not a corrupted script.

import { collectChain, walk } from "./catalog.ts";
import { parseScript, type AstNode } from "./parse.ts";

export type CodemodeDialect = "pi" | "opencode" | "cloudflare" | "unknown";

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

      if (node.type === "Identifier") {
        const name = node.name as string;
        if (name === "ALL_TOOLS") signals.add("pi:ALL_TOOLS");
        if (name === "searchTools" || name === "describeTool" || name === "describeNamespace") {
          signals.add(`pi:${name}`);
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
  }

  const list = [...signals];
  const opencode = list.some(
    (signal) => signal.startsWith("$codemode") || signal === "tools.<namespace>.<tool>" || signal.startsWith("Object.keys(tools"),
  );
  if (opencode) return { dialect: "opencode", signals: list };

  const cloudflareNamespace = list.some((signal) => signal.startsWith("codemode."));
  if (cloudflareNamespace) return { dialect: "cloudflare", signals: list };

  const pi = list.some((signal) => signal.startsWith("pi:"));
  if (pi) return { dialect: "pi", signals: list };

  // A bare async wrapper is Cloudflare's program shape; Pi repairs it but it is
  // still a signal that the model was writing for Cloudflare.
  if (list.includes("async-arrow-wrapper")) return { dialect: "cloudflare", signals: list };

  return { dialect: "unknown", signals: list };
}