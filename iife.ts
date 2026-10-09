// ---------------------------------------------------------------------------
// IIFE unwrapping
// ---------------------------------------------------------------------------
//
// Codemode already runs the script as the body of an async function, so a
// script that wraps itself in one is redundant and, when the model forgets the
// `await`, is never actually executed:
//
//   (async () => {
//     const file = await tools.read({ path: "package.json" });
//     return file;
//   })();
//
// The guard unwraps the body. It only fires when the wrapper is the entire
// script (after the options line), so a deliberate IIFE inside a larger script
// is left alone.

import { parseScript, type AstNode } from "./parse.ts";

export interface UnwrapResult {
  readonly code: string;
  readonly changed: boolean;
}

function unwrapWrapper(expression: AstNode): AstNode {
  if (expression.type === "AwaitExpression" || (expression.type === "UnaryExpression" && expression.operator === "void")) {
    return unwrapWrapper(expression.argument as AstNode);
  }
  return expression;
}

function asyncFunctionBody(expression: AstNode): AstNode | undefined {
  const inner = unwrapWrapper(expression);
  if (inner.type === "CallExpression" && Array.isArray(inner.arguments) && (inner.arguments as unknown[]).length === 0) {
    const callee = inner.callee as AstNode;
    if (callee.type === "ArrowFunctionExpression" || callee.type === "FunctionExpression") {
      return callee.async === true ? callee : undefined;
    }
    return undefined;
  }
  if (
    (inner.type === "ArrowFunctionExpression" || inner.type === "FunctionExpression") &&
    inner.async === true
  ) {
    return inner;
  }
  return undefined;
}

/** Unwrap an async IIFE or async function expression that is the whole script. */
export function unwrapIIFE(code: string): UnwrapResult {
  const ast = parseScript(code);
  if (!ast) return { code, changed: false };

  const statements = (ast.body as AstNode[]).filter((statement) => statement.type !== "EmptyStatement");
  if (statements.length !== 1) return { code, changed: false };

  const statement = statements[0]!;
  if (statement.type !== "ExpressionStatement") return { code, changed: false };

  const fn = asyncFunctionBody(statement.expression as AstNode);
  if (!fn) return { code, changed: false };

  const body = fn.body as AstNode;
  const inner =
    body.type === "BlockStatement"
      ? code.slice(body.start + 1, body.end - 1).trim()
      : code.slice(body.start, body.end).trim();

  return { code: inner, changed: true };
}
