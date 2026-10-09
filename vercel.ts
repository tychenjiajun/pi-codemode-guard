// ---------------------------------------------------------------------------
// Vercel AI SDK code mode dialect -> Pi codemode dialect
// ---------------------------------------------------------------------------
//
// `@ai-sdk/code-mode` (packages/code-mode in the `vercel/ai` repo) runs a
// TypeScript program in an isolated QuickJS sandbox. Its envelope is
// `{ js: string }` and the program API is close to Pi's:
//
//   Vercel AI code mode                         Pi
//   ──────────────────────────────────────────  ─────────────────────────────
//   { js: "..." }                               { code: "..." }
//   tools.getWeather({ location })              tools.getWeather({ location })
//   tools["web-search"]({ q })                  tools.web_search({ q })
//   type annotations, interfaces, `satisfies`   plain JavaScript
//
// Vercel exposes each host tool under its raw name through a `tools` Proxy, so
// a name that is not a valid JavaScript identifier is written with bracket
// access (`tools["web-search"]`). Pi instead exposes `tools.<identifier>` with
// every invalid character replaced by `_`, so this pass rewrites bracket
// accesses to the identifier Pi actually registers, resolving the raw name
// against Pi's live catalog and warning when it is unknown.
//
// The source is TypeScript, so `vercel-typescript` (via `stripTypeScriptSyntax`)
// runs first, before `unwrap-iife`, exactly like the TanStack dialect.

import { buildCatalog, collectBoundNames, resolveToolPath, walk, type Replacement } from "./catalog.ts";
import { parseScript, type AstNode } from "./parse.ts";

export interface VercelCompileOptions {
  /** Pi tool names, from `pi.getAllTools()`. Used to resolve raw Vercel tool names. */
  readonly tools?: readonly string[];
}

export interface VercelCompileResult {
  readonly code: string;
  readonly changed: boolean;
  readonly rewrites: number;
  readonly warnings: readonly string[];
}

/**
 * Rewrite Vercel's raw-name tool access (`tools["web-search"]`) into Pi's
 * `tools.<identifier>`. A no-op on already-Pi code. Call it before the await
 * pass so rewritten tool calls still get their missing `await`.
 */
export function compileVercelDialect(
  code: string,
  options: VercelCompileOptions = {},
): VercelCompileResult {
  const ast = parseScript(code);
  if (!ast) return { code, changed: false, rewrites: 0, warnings: [] };

  const names = options.tools ?? [];
  const catalog = buildCatalog(names);
  // A locally bound `tools` shadows the sandbox global, so leave it alone.
  if (collectBoundNames(ast).has("tools")) return { code, changed: false, rewrites: 0, warnings: [] };
  const replacements: Replacement[] = [];
  const warnings: string[] = [];
  let rewrites = 0;

  walk(ast, [], (node) => {
    if (node.type !== "MemberExpression" || node.computed !== true) return;
    const object = node.object as AstNode;
    if (object.type !== "Identifier" || object.name !== "tools") return;
    const property = node.property as AstNode;
    if (property.type !== "Literal" || typeof property.value !== "string") return;

    const raw = property.value;
    const resolution = resolveToolPath([raw], catalog);
    if (resolution.matched === undefined && names.length > 0) {
      warnings.push(
        `could not resolve Vercel tool \`${raw}\` in the Pi catalog; mapped to \`tools.${resolution.identifier}\``,
      );
    }
    // Preserve `tools?.["x"]` as `tools?.x` rather than dropping the guard.
    const accessor = node.optional === true ? "?." : ".";
    const text = `tools${accessor}${resolution.identifier}`;
    if (code.slice(node.start, node.end) !== text) {
      replacements.push({ start: node.start, end: node.end, text });
      rewrites++;
    }
  });

  if (replacements.length === 0) return { code, changed: false, rewrites: 0, warnings };

  replacements.sort((a, b) => b.start - a.start);
  let result = code;
  for (const replacement of replacements) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return { code: result, changed: true, rewrites, warnings };
}
