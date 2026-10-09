// ---------------------------------------------------------------------------
// DeepSeek Harness PTC dialect -> Pi codemode dialect
// ---------------------------------------------------------------------------
//
// `@deepseek-ai/dsh-ptc-runtime-node` (packages/ptc-runtime/ptc-runtime-node in
// the `deepseek-ai/deepseek-harness` repo) runs an async TypeScript function
// body via the `run_code` tool (`{ description, code }`), so top-level
// `await`/`return` work like in Pi. Its program API differs in a few places:
//
//   DeepSeek Harness PTC                          Pi
//   ──────────────────────────────────────────  ─────────────────────────────
//   tools.name(args) / tools["raw-name"](args)  tools.<identifier>(args)
//   Object.keys(tools)                          ALL_TOOLS.map(t => t.name)
//   ToolCallError (PTC-only global)             plain rejected value
//   await import("node:fs") (Node APIs)         not available in QuickJS
//
// PTC's host functions are exposed as own properties on a null-prototype
// global object, so function names are arbitrary strings: a name that is not a
// valid JavaScript identifier is written with bracket access
// (`tools["my-tool"]`). Pi instead exposes `tools.<identifier>` with every
// invalid character replaced by `_`, so this pass rewrites bracket accesses to
// the identifier Pi actually registers, resolving the raw name against Pi's
// live catalog and warning when it is unknown.
//
// PTC-only features have no Pi equivalent; they are reported as warnings, one
// per kind, while the script itself is left alone (best-effort: an unparseable
// script returns unchanged).

import {
  buildCatalog,
  collectBoundNames,
  collectChain,
  resolveToolPath,
  walk,
  type Replacement,
} from "./catalog.ts";
import { parseScript, type AstNode } from "./parse.ts";

export interface PtcCompileOptions {
  /** Pi tool names, from `pi.getAllTools()`. Used to resolve raw PTC tool names. */
  readonly tools?: readonly string[];
}

export interface PtcCompileResult {
  readonly code: string;
  readonly changed: boolean;
  readonly rewrites: number;
  readonly warnings: readonly string[];
}

/**
 * Rewrite PTC's raw-name tool access (`tools["web-search"]`) into Pi's
 * `tools.<identifier>`. A no-op on already-Pi code. Call it before the await
 * pass so rewritten tool calls still get their missing `await`.
 */
export function compilePtcDialect(code: string, options: PtcCompileOptions = {}): PtcCompileResult {
  const ast = parseScript(code);
  if (!ast) return { code, changed: false, rewrites: 0, warnings: [] };

  const names = options.tools ?? [];
  const catalog = buildCatalog(names);
  // A locally bound `tools` shadows the sandbox global, so its accesses and
  // `Object.keys(tools)` must not be rewritten — but the PTC-only globals
  // (`ToolCallError`, `import()`) are independent of that binding and still warn.
  const toolsBound = collectBoundNames(ast).has("tools");
  const replacements: Replacement[] = [];
  const warnings: string[] = [];
  const warned = new Set<string>();
  let rewrites = 0;

  walk(ast, [], (node) => {
    if (node.type === "ImportExpression") {
      if (!warned.has("import")) {
        warned.add("import");
        warnings.push(
          "dynamic `import()` is PTC/Node-only: Pi's QuickJS sandbox has no Node APIs and cannot load modules",
        );
      }
      return;
    }

    if (node.type === "Identifier" && node.name === "ToolCallError") {
      if (!warned.has("ToolCallError")) {
        warned.add("ToolCallError");
        warnings.push(
          "`ToolCallError` is PTC-only and undefined in Pi; catch the plain rejection value instead",
        );
      }
      return;
    }

    if (node.type === "CallExpression") {
      if (toolsBound) return;
      // `Object.keys(tools)` is PTC's tool-discovery channel; Pi lists them in
      // the `ALL_TOOLS` global.
      const chain = collectChain(node.callee as AstNode);
      if (chain?.root === "Object" && chain.segments.join(".") === "keys") {
        const first = (node.arguments as AstNode[])[0];
        const target = first ? collectChain(first) : undefined;
        if (target?.root === "tools" && target.segments.length === 0) {
          const text = "ALL_TOOLS.map((__ptc_tool) => __ptc_tool.name)";
          if (code.slice(node.start, node.end) !== text) {
            replacements.push({ start: node.start, end: node.end, text });
            rewrites++;
          }
        }
      }
      return;
    }

    if (node.type !== "MemberExpression" || node.computed !== true) return;
    if (toolsBound) return;
    const object = node.object as AstNode;
    if (object.type !== "Identifier" || object.name !== "tools") return;
    const property = node.property as AstNode;
    if (property.type !== "Literal" || typeof property.value !== "string") return;

    const raw = property.value;
    const resolution = resolveToolPath([raw], catalog);
    if (resolution.matched === undefined && names.length > 0 && !warned.has(`unresolved:${resolution.identifier}`)) {
      warned.add(`unresolved:${resolution.identifier}`);
      warnings.push(
        `could not resolve PTC tool \`${raw}\` in the Pi catalog; mapped to \`tools.${resolution.identifier}\``,
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
