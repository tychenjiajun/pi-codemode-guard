// ---------------------------------------------------------------------------
// Statement-based codemode translation
// ---------------------------------------------------------------------------
//
// The guard used to detect one dialect for the whole snippet and run that
// dialect's compiler. A snippet frequently mixes constructs — a model reaching
// for two harnesses, or a namespace path next to a bracket call — and then only
// the detected dialect's statements were repaired.
//
// `translateCodemode` parses the source once and translates each construct by
// its shape, not by the snippet's dialect: OpenCode namespace paths and
// `$codemode.search`, Cloudflare `codemode.*` and named providers, TanStack
// `external_<tool>` bindings, Vercel/PTC `tools["raw-name"]` access, Codex-only
// helpers, and bare tool calls (`search(...)` -> `tools.search(...)`). Each
// construct is matched independently, so one statement can be OpenCode while the
// next is Vercel.
//
// The detected `dialect` is still passed in, but only to disambiguate the two
// constructs that genuinely overlap between dialects:
//
//   * `Object.keys(tools)`       — OpenCode spells the names `__cm_tool`, PTC
//                                  spells them `__ptc_tool`; PTC also warns about
//                                  `Object.keys(tools.<ns>)` rather than
//                                  rewriting it.
//   * unresolved bracket names   — only the Vercel/PTC dialects own the warning
//                                  (a plain-JavaScript bracket is repaired
//                                  silently by `rewrite-tool-identifiers`).
//
// Every rule only rewrites a chain whose root the script does not bind itself
// (`const tools = …` leaves the script's own object alone) and, for ambiguous
// constructs, only when the live catalog confirms the name. The whole
// translation is best-effort: an unparseable script is returned unchanged, and
// the rules are idempotent (a translated script has no construct left to match).

import { buildCatalog, collectChain, resolveToolPath } from "../core/catalog.ts";
import { buildCloudflareCatalog, resolveCloudflarePath } from "../core/cloudflare-names.ts";
import { parseScript, walk, type AstNode } from "../core/parse.ts";
import { PI_SANDBOX_GLOBALS } from "../core/pi-globals.ts";
import { applyReplacements, selectReplacements, type Replacement } from "../core/replacements.ts";
import { collectBoundNames, isReferenceIdentifier, isShadowedAt } from "../core/scope.ts";
import { CLOUDFLARE_PLATFORM_SHIMS, CLOUDFLARE_PLATFORM_UNSUPPORTED, CODEMODE_KEYS_SHIM, namespaceKeysShim, OPENCODE_SEARCH_SHIM } from "../core/shims.ts";
import { TANSTACK_BINDING_PREFIX, UNSUPPORTED_GLOBAL_BY_NAME } from "./signals.ts";

// Re-exported so the public translate subpath keeps exposing the Cloudflare
// name helpers it always has.
export { cloudflareSanitize, cloudflareUnsanitize } from "../core/cloudflare-names.ts";

export type TranslateGroup = "opencode" | "cloudflare" | "tanstack" | "vercel" | "ptc" | "codex" | "bare";

export interface TranslateOptions {
  /** Pi tool names, from `pi.getAllTools()`. */
  readonly tools?: readonly string[];
  /**
   * Run only one dialect's rules. Used by the standalone dialect compilers so
   * their output stays byte-compatible; the compile pipeline runs every group.
   */
  readonly only?: TranslateGroup;
  /** The dialect detected for the whole snippet; disambiguates shared constructs. */
  readonly dialect?: string;
}

export interface TranslateResult {
  readonly code: string;
  readonly changed: boolean;
  /** Total replacements applied. */
  readonly rewrites: number;
  /** Warnings from every rule, deduplicated, in rule order. */
  readonly warnings: readonly string[];
  /** Replacements per group, for pass attribution. */
  readonly groups: Readonly<Partial<Record<TranslateGroup, number>>>;
}

interface Candidate extends Replacement {
  readonly group: TranslateGroup;
}

// ---------------------------------------------------------------------------
// Runtime globals
// ---------------------------------------------------------------------------

/** Globals that are never a tool namespace or a bare tool call. */
const JS_GLOBALS = new Set([
  "Array", "ArrayBuffer", "Atomics", "BigInt", "Boolean", "DataView", "Date", "Error", "EvalError",
  "FinalizationRegistry", "Float32Array", "Float64Array", "Infinity", "Int16Array", "Int32Array",
  "Int8Array", "Intl", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy",
  "RangeError", "ReferenceError", "Reflect", "RegExp", "Set", "String", "Symbol", "SyntaxError",
  "TypeError", "URIError", "Uint16Array", "Uint32Array", "Uint8Array", "Uint8ClampedArray",
  "WeakMap", "WeakRef", "WeakSet", "console", "globalThis", "undefined",
]);

/** Pi codemode sandbox helpers: addresses, not provider namespaces or tool calls. */
const PI_HELPERS = new Set(PI_SANDBOX_GLOBALS);

/** Names a bare call may never be rewritten into `tools.<name>`. */
const RESERVED_GLOBALS = new Set([...JS_GLOBALS, ...PI_HELPERS]);

// ---------------------------------------------------------------------------
// Statement translation
// ---------------------------------------------------------------------------

/** Whether `node` is the object half of a member expression, i.e. not the final property. */
function isInnerMember(node: AstNode, parents: readonly AstNode[]): boolean {
  const parent = parents[parents.length - 1];
  return parent?.type === "MemberExpression" && parent.object === node;
}

/** Whether `node` is the argument of an `Object.keys(...)` call — that call owns the replacement range. */
function isObjectKeysTarget(node: AstNode, parents: readonly AstNode[]): boolean {
  const parent = parents[parents.length - 1];
  if (parent?.type !== "CallExpression") return false;
  if ((parent.arguments as AstNode[] | undefined)?.[0] !== node) return false;
  const chain = collectChain(parent.callee as AstNode);
  return chain?.root === "Object" && chain.segments.join(".") === "keys";
}

/**
 * Translate every dialect construct in `code` into Pi codemode syntax. A no-op
 * on already-Pi code. Call it before the await pass so rewritten tool calls
 * still get their missing `await`.
 */
export function translateCodemode(code: string, options: TranslateOptions = {}): TranslateResult {
  const ast = parseScript(code);
  if (!ast) return { code, changed: false, rewrites: 0, warnings: [], groups: {} };

  const names = options.tools ?? [];
  const catalog = buildCatalog(names);
  const cloudflareCatalog = buildCloudflareCatalog(names);
  const bound = collectBoundNames(ast);
  const toolsBound = bound.has("tools");
  const only = options.only;
  const dialect = options.dialect ?? "unknown";

  const enabled = (group: TranslateGroup): boolean => only === undefined || only === group;
  // A direct `tools["x"]` bracket is owned by Vercel/PTC when that dialect is in
  // play; every other snippet is left to `rewrite-tool-identifiers` (which is
  // catalog-aware and warning-free).
  const bracketGroup: TranslateGroup | undefined =
    only === "vercel" || only === "ptc"
      ? only
      : only === undefined && (dialect === "vercel" || dialect === "ptc")
        ? (dialect as TranslateGroup)
        : undefined;
  // `Object.keys(tools)` is shared between OpenCode and PTC; the detected dialect
  // (or the requested group) decides the spelling and the PTC-only warning.
  const keysGroup: TranslateGroup =
    only === "ptc" || (only === undefined && dialect === "ptc") ? "ptc" : "opencode";

  const candidates: Candidate[] = [];
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    warnings.push(message);
  };
  const push = (node: AstNode, text: string, group: TranslateGroup): void => {
    if (code.slice(node.start, node.end) === text) return;
    candidates.push({ start: node.start, end: node.end, text, group });
  };

  const opencodeMember = (node: AstNode, chain: { root: string; segments: string[] }): void => {
    if (!enabled("opencode")) return;
    if (chain.segments[0] === "$codemode") {
      if (chain.segments.length === 2 && chain.segments[1] === "search") {
        push(node, OPENCODE_SEARCH_SHIM, "opencode");
      } else {
        warn(
          `$codemode:${chain.segments.slice(1).join(".")}`,
          `unsupported OpenCode \`$codemode.${chain.segments.slice(1).join(".")}\`; left unchanged`,
        );
      }
      return;
    }
    if (chain.segments.length < 2) return;
    // A property access on a live tool handle — `tools.read.length`,
    // `tools.bash.output` — is not a namespace path: the FIRST segment alone
    // already resolves to a catalog tool, so there is nothing to flatten.
    // Detection stays catalog-free (it still reports this shape as `opencode`,
    // see detect.ts), but translation must never rewrite or warn here — the
    // flattened `tools.read__length` throws in Pi's sandbox.
    if (resolveToolPath([chain.segments[0]!], catalog).matched !== undefined) return;
    // Only treat a nested `tools.<a>.<b>` path as a namespace path when the
    // detected dialect is OpenCode, or the live catalog confirms the path.
    // Otherwise `tools.read.length` (a function property) would be flattened.
    const resolution = resolveToolPath(chain.segments, catalog);
    if (resolution.matched === undefined && dialect !== "opencode") return;
    if (resolution.matched === undefined && names.length > 0) {
      warn(
        `opencode-unresolved:${resolution.identifier}`,
        `could not resolve OpenCode tool path \`tools.${chain.segments.join(".")}\` in the Pi catalog; flattened to \`tools.${resolution.identifier}\``,
      );
    }
    push(node, `tools.${resolution.identifier}`, "opencode");
  };

  const cloudflareMember = (node: AstNode, chain: { root: string; segments: string[] }): void => {
    if (!enabled("cloudflare")) return;
    if (chain.root === "codemode") {
      if (chain.segments.length > 1) {
        warn(
          `codemode.path:${chain.segments.join(".")}`,
          `unexpected Cloudflare \`codemode.${chain.segments.join(".")}\` path; left unchanged`,
        );
        return;
      }
      const method = chain.segments[0]!;
      const shim = CLOUDFLARE_PLATFORM_SHIMS[method];
      if (shim !== undefined) {
        push(node, shim, "cloudflare");
        return;
      }
      if (CLOUDFLARE_PLATFORM_UNSUPPORTED.includes(method)) {
        warn(`codemode.${method}`, `\`codemode.${method}\` has no Pi equivalent; left unchanged`);
        return;
      }
      const resolution = resolveCloudflarePath([method], cloudflareCatalog);
      if (resolution.matched === undefined && names.length > 0) {
        warn(
          `cloudflare-unresolved:${resolution.identifier}`,
          `could not resolve Cloudflare tool \`codemode.${method}\` in the Pi catalog; mapped to \`tools.${resolution.identifier}\``,
        );
      }
      push(node, `tools.${resolution.identifier}`, "cloudflare");
      return;
    }

    // A named provider namespace, e.g. `state.readFile` or `github.list_pull_requests`.
    // The provider is the chain root, so include it in the path. Only rewrite when
    // the catalog confirms it: never flatten an arbitrary global or a local object's method.
    const path = [chain.root, ...chain.segments];
    const resolution = resolveCloudflarePath(path, cloudflareCatalog);
    if (resolution.matched === undefined) {
      if (names.length > 0) {
        warn(
          `cloudflare-provider:${path.join(".")}`,
          `could not resolve Cloudflare provider \`${path.join(".")}\` in the Pi catalog; left unchanged`,
        );
      }
      return;
    }
    push(node, `tools.${resolution.identifier}`, "cloudflare");
  };

  walk(ast, [], (node, parents) => {
    if (node.type === "ImportExpression") {
      if (enabled("ptc")) {
        warn(
          "ptc:import",
          "dynamic `import()` is PTC/Node-only: Pi's QuickJS sandbox has no Node APIs and cannot load modules",
        );
      }
      return;
    }

    if (node.type === "Identifier") {
      const name = node.name as string;
      const unsupported = UNSUPPORTED_GLOBAL_BY_NAME.get(name);
      if (unsupported && enabled(unsupported.dialect) && isReferenceIdentifier(node, parents) && !bound.has(name)) {
        warn(`unsupported:${name}`, unsupported.message);
      }
      if (
        enabled("tanstack") &&
        name.startsWith(TANSTACK_BINDING_PREFIX) &&
        name.length > TANSTACK_BINDING_PREFIX.length &&
        isReferenceIdentifier(node, parents) &&
        !isShadowedAt(node, parents, name)
      ) {
        const binding = name.slice(TANSTACK_BINDING_PREFIX.length);
        const resolution = resolveToolPath([binding], catalog);
        if (resolution.matched === undefined && names.length > 0) {
          warn(
            `tanstack-unresolved:${resolution.identifier}`,
            `could not resolve TanStack binding \`${name}\` in the Pi catalog; mapped to \`tools.${resolution.identifier}\``,
          );
        }
        const parent = parents[parents.length - 1];
        const shorthand = parent?.type === "Property" && parent.shorthand === true && parent.value === node;
        // Acorn gives shorthand properties distinct key/value nodes at the same
        // range: rewriting the value alone would leave `{ tools.foo }`, which is
        // not valid JavaScript, so emit `external_foo: tools.foo` instead.
        push(node, shorthand ? `${name}: tools.${resolution.identifier}` : `tools.${resolution.identifier}`, "tanstack");
      }
      return;
    }

    if (node.type === "CallExpression") {
      // `Object.keys(tools)` / `Object.keys(tools.<ns>)` — OpenCode/PTC discovery.
      const calleeChain = collectChain(node.callee as AstNode);
      if (calleeChain?.root === "Object" && calleeChain.segments.join(".") === "keys" && enabled(keysGroup)) {
        const first = (node.arguments as AstNode[])[0];
        const target = first ? collectChain(first) : undefined;
        if (target?.root === "tools" && !toolsBound) {
          if (target.segments.length === 0) {
            const variable = keysGroup === "ptc" ? "__ptc_tool" : "__cm_tool";
            push(node, `ALL_TOOLS.map((${variable}) => ${variable}.name)`, keysGroup);
          } else if (target.segments[0] === "$codemode" && target.segments.length === 1) {
            push(node, CODEMODE_KEYS_SHIM, "opencode");
          } else if (keysGroup === "ptc") {
            // Pi's `tools` is flat: `tools.<ns>` is `undefined`, so this would
            // throw `TypeError: Cannot convert undefined or null to object`
            // at runtime. There is no namespace to enumerate — warn loudly.
            warn(
              `ptc-keys:${target.segments.join(".")}`,
              `\`Object.keys(tools.${target.segments.join(".")})\` will throw at runtime: Pi's \`tools\` is flat and has no \`${target.segments[0]}\` namespace; list names with \`ALL_TOOLS.map((t) => t.name)\` instead`,
            );
          } else {
            push(node, namespaceKeysShim(target.segments), "opencode");
          }
        }
      }

      // A bare tool call: `search({ ... })` -> `tools.search({ ... })`. Only when
      // the live catalog knows the name, the script does not bind it, and it is
      // not a sandbox helper — this is the statement-level translation of a
      // model that forgot the `tools.` prefix.
      if (enabled("bare")) {
        const callee = node.callee as AstNode;
        if (callee.type === "Identifier") {
          const name = callee.name as string;
          if (
            names.length > 0 &&
            !RESERVED_GLOBALS.has(name) &&
            !name.startsWith(TANSTACK_BINDING_PREFIX) &&
            !bound.has(name) &&
            !isShadowedAt(callee, parents, name)
          ) {
            const resolution = resolveToolPath([name], catalog);
            if (resolution.matched !== undefined) {
              push(callee, `tools.${resolution.identifier}`, "bare");
            }
          }
        }
      }
      return;
    }

    if (node.type === "ForInStatement") {
      if (!enabled("opencode") || toolsBound) return;
      const chain = collectChain(node.right as AstNode);
      if (chain?.root === "tools" && chain.segments.length > 0) {
        warn(
          `opencode-forin:${chain.segments.join(".")}`,
          `\`for...in tools.${chain.segments.join(".")}\` iterates nothing in Pi (\`tools\` is flat); use \`ALL_TOOLS.map((t) => t.name)\` instead`,
        );
      }
      return;
    }

    if (node.type !== "MemberExpression") return;
    if (isInnerMember(node, parents)) return;
    if (isObjectKeysTarget(node, parents)) return;
    const chain = collectChain(node);
    if (!chain || chain.segments.length === 0) return;

    if (chain.root === "tools" && !toolsBound) {
      const object = node.object as AstNode;
      const directBracket =
        node.computed === true && object.type === "Identifier" && object.name === "tools";
      if (directBracket) {
        if (!bracketGroup || !enabled(bracketGroup)) return;
        const property = node.property as AstNode;
        if (property.type !== "Literal" || typeof property.value !== "string") return;
        const raw = property.value;
        const resolution = resolveToolPath([raw], catalog);
        if (resolution.matched === undefined && names.length > 0) {
          warn(
            `${bracketGroup}-unresolved:${resolution.identifier}`,
            `could not resolve ${bracketGroup === "vercel" ? "Vercel" : "PTC"} tool \`${raw}\` in the Pi catalog; mapped to \`tools.${resolution.identifier}\``,
          );
        }
        // Preserve `tools?.["x"]` as `tools?.x` rather than dropping the guard.
        const accessor = node.optional === true ? "?." : ".";
        push(node, `tools${accessor}${resolution.identifier}`, bracketGroup);
        return;
      }
      opencodeMember(node, chain);
      return;
    }

    if (bound.has(chain.root)) return;
    if (JS_GLOBALS.has(chain.root) || PI_HELPERS.has(chain.root)) return;
    if (chain.root === "codemode") {
      cloudflareMember(node, chain);
      return;
    }
    if (chain.segments.length >= 1) cloudflareMember(node, chain);
  });

  const chosen = selectReplacements(candidates);
  const groups: Partial<Record<TranslateGroup, number>> = {};
  for (const candidate of chosen) groups[candidate.group] = (groups[candidate.group] ?? 0) + 1;

  if (chosen.length === 0) {
    return { code, changed: false, rewrites: 0, warnings, groups };
  }

  return { code: applyReplacements(code, chosen), changed: true, rewrites: chosen.length, warnings, groups };
}

// ---------------------------------------------------------------------------
// Single-dialect entry points
// ---------------------------------------------------------------------------
//
// The old `opencode.ts` / `cloudflare.ts` / `tanstack.ts` / `vercel.ts` /
// `ptc.ts` / `codex.ts` modules each held their own compiler. They are now
// data-driven wrappers over `translateCodemode` with `only` set, so the
// rewriting rules have exactly one home while the per-dialect API (and its
// isolated tests) stays.

export interface DialectCompileOptions {
  /** Pi tool names, from `pi.getAllTools()`. */
  readonly tools?: readonly string[];
}

export interface DialectCompileResult {
  readonly code: string;
  readonly changed: boolean;
  readonly rewrites: number;
  readonly warnings: readonly string[];
}

function compileOnly(
  group: TranslateGroup,
  code: string,
  options: DialectCompileOptions,
): DialectCompileResult {
  const result = translateCodemode(code, { tools: options.tools, only: group, dialect: group });
  return {
    code: result.code,
    changed: result.changed,
    rewrites: result.groups[group] ?? 0,
    warnings: result.warnings,
  };
}

/** OpenCode's `@opencode-ai/codemode` → Pi rules. */
export function compileOpencodeDialect(
  code: string,
  options: DialectCompileOptions = {},
): DialectCompileResult {
  return compileOnly("opencode", code, options);
}

/** Cloudflare agents `@cloudflare/codemode` → Pi rules. */
export function compileCloudflareDialect(
  code: string,
  options: DialectCompileOptions = {},
): DialectCompileResult {
  return compileOnly("cloudflare", code, options);
}

/** TanStack AI `@tanstack/ai-code-mode` → Pi rules. */
export function compileTanstackDialect(
  code: string,
  options: DialectCompileOptions = {},
): DialectCompileResult {
  return compileOnly("tanstack", code, options);
}

/** Vercel AI SDK `@ai-sdk/code-mode` → Pi rules. */
export function compileVercelDialect(
  code: string,
  options: DialectCompileOptions = {},
): DialectCompileResult {
  return compileOnly("vercel", code, options);
}

/** DeepSeek Harness PTC → Pi rules. */
export function compilePtcDialect(
  code: string,
  options: DialectCompileOptions = {},
): DialectCompileResult {
  return compileOnly("ptc", code, options);
}

/** OpenAI Codex code mode → Pi rules (pragma + helper warnings). */
export function compileCodexDialect(
  code: string,
  options: DialectCompileOptions = {},
): DialectCompileResult {
  return compileOnly("codex", code, options);
}
