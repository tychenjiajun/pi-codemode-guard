// ---------------------------------------------------------------------------
// TanStack AI code mode dialect -> Pi codemode dialect
// ---------------------------------------------------------------------------
//
// `@tanstack/ai-code-mode` exposes a different program API than Pi:
//
//   TanStack AI                                Pi
//   ─────────────────────────────────────────  ──────────────────────────────
//   { typescriptCode: "..." }                  { code: "..." }
//   external_getWeather({ location })          tools.getWeather({ location })
//   type annotations, interfaces, `as`         plain JavaScript
//
// Each tool becomes a global `external_<name>` async function in the TanStack
// sandbox; Pi instead addresses tools through `tools.<identifier>`. The code is
// TypeScript, so `compileTanstackDialect` is always preceded by
// `stripTypeScriptSyntax`, and the caller passes Pi's live tool catalog so the
// binding name can be resolved through `resolveToolPath`.
//
// Everything else (top-level `return`, `await`, `console.log`, `Promise.all`)
// is already valid Pi.

import { buildCatalog, collectBoundNames, resolveToolPath, walk, type Replacement } from "./catalog.ts";
import { parseScript, type AstNode } from "./parse.ts";

/** TanStack's binding prefix for tools exposed inside the sandbox. */
export const TANSTACK_BINDING_PREFIX = "external_";

export interface TanstackCompileOptions {
  /** Pi tool names, from `pi.getAllTools()`. Used to resolve `external_<name>`. */
  readonly tools?: readonly string[];
}

export interface TanstackCompileResult {
  readonly code: string;
  readonly changed: boolean;
  readonly rewrites: number;
  readonly warnings: readonly string[];
}

/** Keys and labels are not references, so rewriting them would corrupt the script. */
function isReferenceIdentifier(node: AstNode, parents: readonly AstNode[]): boolean {
  const parent = parents[parents.length - 1];
  if (!parent) return true;
  if (parent.type === "MemberExpression" && parent.property === node) return false;
  if (parent.type === "Property" && parent.key === node) return false;
  if ((parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parent.key === node) return false;
  if (parent.type === "LabeledStatement" && parent.label === node) return false;
  if ((parent.type === "BreakStatement" || parent.type === "ContinueStatement") && parent.label === node) return false;
  return true;
}

/**
 * Rewrite TanStack's `external_<tool>` bindings into Pi's `tools.<identifier>`.
 * A no-op on already-Pi code. Call it before the await pass so rewritten tool
 * calls still get their missing `await`.
 */
export function compileTanstackDialect(
  code: string,
  options: TanstackCompileOptions = {},
): TanstackCompileResult {
  const ast = parseScript(code);
  if (!ast) return { code, changed: false, rewrites: 0, warnings: [] };

  const names = options.tools ?? [];
  const catalog = buildCatalog(names);
  const bound = collectBoundNames(ast);
  const replacements: Replacement[] = [];
  const warnings: string[] = [];
  let rewrites = 0;

  walk(ast, [], (node, parents) => {
    if (node.type !== "Identifier") return;
    const name = node.name as string;
    if (!name.startsWith(TANSTACK_BINDING_PREFIX) || name.length === TANSTACK_BINDING_PREFIX.length) return;
    if (bound.has(name) || !isReferenceIdentifier(node, parents)) return;

    const binding = name.slice(TANSTACK_BINDING_PREFIX.length);
    const resolution = resolveToolPath([binding], catalog);
    if (resolution.matched === undefined && names.length > 0) {
      warnings.push(
        `could not resolve TanStack binding \`${name}\` in the Pi catalog; mapped to \`tools.${resolution.identifier}\``,
      );
    }
    const text = `tools.${resolution.identifier}`;
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