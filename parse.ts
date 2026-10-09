// ---------------------------------------------------------------------------
// Shared acorn parsing
// ---------------------------------------------------------------------------
//
// Codemode scripts run as the body of an async function, so top-level `await`
// and `return` are legal. Acorn is asked to accept exactly that, and to fall
// back to module parsing for the rare script that contains `import`/`export`.

import { parse } from "acorn";

export interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

const BASE_OPTIONS = {
  ecmaVersion: "latest" as const,
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowHashBang: true,
  locations: false,
  ranges: false,
};

/** Parse script source, returning `undefined` instead of throwing. */
export function parseScript(code: string): AstNode | undefined {
  for (const sourceType of ["script", "module"] as const) {
    try {
      return parse(code, { ...BASE_OPTIONS, sourceType }) as unknown as AstNode;
    } catch {
      // Try the next source type.
    }
  }
  return undefined;
}

/** Child AST nodes of `node`, in source order. */
export function childNodes(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (isAstNode(entry)) children.push(entry);
      }
    } else if (isAstNode(value)) {
      children.push(value);
    }
  }
  children.sort((a, b) => a.start - b.start);
  return children;
}

export function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { start?: unknown }).start === "number" &&
    typeof (value as { end?: unknown }).end === "number"
  );
}

/** Whether `node` introduces a function scope, and whether that scope is async. */
export function isFunctionNode(node: AstNode): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}
