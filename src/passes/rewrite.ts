// ---------------------------------------------------------------------------
// Tool identifier rewriting
// ---------------------------------------------------------------------------
//
// A script addresses a tool by its codemode identifier: `tools.my_tool`. When a
// model is unsure of the identifier it often uses bracket access with the raw
// tool name, which is either wrong or a syntax error for names with `-`:
//
//   tools["mcp__dev-radius__search"]({ query: "x" })
//
// The guard rewrites bracket access to the identifier pi actually exposes:
//
//   tools.mcp__dev_radius__search({ query: "x" })

import { buildCatalog, resolveToolPath } from "../core/catalog.ts";
import { isIdentifierName, toCodemodeIdentifier } from "../core/identifiers.ts";
import { childNodes, parseScript, type AstNode } from "../core/parse.ts";
import { applyReplacements, type Replacement } from "../core/replacements.ts";
import { collectBoundNames } from "../core/scope.ts";

const REWRITE_OBJECTS = new Set(["tools", "models"]);

export interface IdentifierRewriteResult {
  readonly code: string;
  readonly changed: boolean;
  readonly rewrites: number;
}

/**
 * Rewrite `tools["a-b"]` / `tools["read"]` to dot access with pi's identifier.
 *
 * When `tools` (the live Pi tool catalog) is given, bracket access on `tools`
 * resolves through `resolveToolPath` first — the same exact/fuzzy matching the
 * dialect passes use — so `tools["mcp.dev.radius.search"]` maps to the real
 * registered identifier `mcp__dev_radius_search`, not the naive
 * `mcp_dev_radius_search`. A name the catalog cannot resolve falls back to the
 * naive identifier, exactly as the no-catalog path, and stays warning-free:
 * the dialect passes (Vercel/PTC) already warn about unresolved names, and this
 * pass is the shared fallback for plain-JS bracket access where no dialect
 * claimed the script. `models` access is always naive — the catalog lists
 * tools, not models.
 */
export function rewriteToolIdentifiers(
  code: string,
  tools?: readonly string[],
): IdentifierRewriteResult | undefined {
  const ast = parseScript(code);
  if (!ast) return undefined;

  const bound = collectBoundNames(ast);
  const catalog = tools && tools.length > 0 ? buildCatalog(tools) : undefined;
  const replacements: Replacement[] = [];

  const visit = (node: AstNode): void => {
    if (node.type === "MemberExpression" && node.computed === true) {
      const object = node.object as AstNode;
      const property = node.property as AstNode;
      if (
        object.type === "Identifier" &&
        REWRITE_OBJECTS.has(object.name as string) &&
        !bound.has(object.name as string) &&
        property.type === "Literal" &&
        typeof property.value === "string"
      ) {
        const raw = property.value as string;
        // Catalog-aware: resolve against the live catalog when rewriting `tools`
        // and one was supplied. For a name the catalog cannot match,
        // `resolveToolPath` falls back to `toCodemodeIdentifier(raw)` — the same
        // naive identifier the no-catalog path produces — so unresolved names
        // behave exactly as before.
        const identifier =
          catalog !== undefined && object.name === "tools"
            ? resolveToolPath([raw], catalog).identifier
            : toCodemodeIdentifier(raw);
        if (isIdentifierName(identifier)) {
          // Preserve `tools?.["x"]` as `tools?.x` rather than dropping the guard.
          const accessor = node.optional === true ? "?." : ".";
          const text = `${object.name as string}${accessor}${identifier}`;
          if (code.slice(node.start, node.end) !== text) {
            replacements.push({ start: node.start, end: node.end, text });
          }
        }
      }
    }
    for (const child of childNodes(node)) visit(child);
  };

  visit(ast);
  if (replacements.length === 0) return { code, changed: false, rewrites: 0 };

  return {
    code: applyReplacements(code, replacements),
    changed: true,
    rewrites: replacements.length,
  };
}
