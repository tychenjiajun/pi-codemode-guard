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

import { isIdentifierName, toCodemodeIdentifier } from "./identifiers.ts";
import { childNodes, parseScript, type AstNode } from "./parse.ts";

const REWRITE_OBJECTS = new Set(["tools", "models"]);

export interface IdentifierRewriteResult {
  readonly code: string;
  readonly changed: boolean;
  readonly rewrites: number;
}

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Rewrite `tools["a-b"]` / `tools["read"]` to dot access with pi's identifier. */
export function rewriteToolIdentifiers(code: string): IdentifierRewriteResult | undefined {
  const ast = parseScript(code);
  if (!ast) return undefined;

  const replacements: Replacement[] = [];

  const visit = (node: AstNode): void => {
    if (node.type === "MemberExpression" && node.computed === true) {
      const object = node.object as AstNode;
      const property = node.property as AstNode;
      if (
        object.type === "Identifier" &&
        REWRITE_OBJECTS.has(object.name as string) &&
        property.type === "Literal" &&
        typeof property.value === "string"
      ) {
        const identifier = toCodemodeIdentifier(property.value);
        if (isIdentifierName(identifier)) {
          const text = `${object.name as string}.${identifier}`;
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

  replacements.sort((a, b) => b.start - a.start);
  let result = code;
  for (const replacement of replacements) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return { code: result, changed: true, rewrites: replacements.length };
}
