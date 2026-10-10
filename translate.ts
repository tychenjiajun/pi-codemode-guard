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

import {
  buildCatalog,
  collectBoundNames,
  collectChain,
  normalizeToolKey,
  resolveToolPath,
  walk,
  type Catalog,
  type Replacement,
  type Resolution,
} from "./catalog.ts";
import { toCodemodeIdentifier } from "./identifiers.ts";
import { childNodes, parseScript, type AstNode } from "./parse.ts";
import { CODEMODE_KEYS_SHIM, CLOUDFLARE_DESCRIBE_SHIM, CLOUDFLARE_SEARCH_SHIM, namespaceKeysShim, OPENCODE_SEARCH_SHIM } from "./shims.ts";

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
// Cloudflare's name rules and runtime globals
// ---------------------------------------------------------------------------

/** Cloudflare's reserved-word set, copied from `@cloudflare/codemode`'s utils. */
const JS_RESERVED = new Set([
  "abstract", "arguments", "await", "boolean", "break", "byte", "case", "catch", "char", "class",
  "const", "continue", "debugger", "default", "delete", "do", "double", "else", "enum", "eval",
  "export", "extends", "false", "final", "finally", "float", "for", "function", "goto", "if",
  "implements", "import", "in", "instanceof", "int", "interface", "let", "long", "native", "new",
  "null", "package", "private", "protected", "public", "return", "short", "static", "super",
  "switch", "synchronized", "this", "throw", "throws", "transient", "true", "try", "typeof",
  "undefined", "var", "void", "volatile", "while", "with", "yield",
]);

/** Globals that are never a Cloudflare provider namespace. */
const JS_GLOBALS = new Set([
  "Array", "ArrayBuffer", "Atomics", "BigInt", "Boolean", "DataView", "Date", "Error", "EvalError",
  "FinalizationRegistry", "Float32Array", "Float64Array", "Infinity", "Int16Array", "Int32Array",
  "Int8Array", "Intl", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy",
  "RangeError", "ReferenceError", "Reflect", "RegExp", "Set", "String", "Symbol", "SyntaxError",
  "TypeError", "URIError", "Uint16Array", "Uint32Array", "Uint8Array", "Uint8ClampedArray",
  "WeakMap", "WeakRef", "WeakSet", "console", "globalThis", "undefined",
]);

/** Pi codemode sandbox helpers: addresses, not provider namespaces or tool calls. */
const PI_HELPERS = new Set([
  "tools", "models", "text", "image", "ALL_TOOLS", "searchTools", "describeTool", "describeNamespace",
  "store", "load", "exit", "structuredClone", "queueMicrotask",
]);

/** Names a bare call may never be rewritten into `tools.<name>`. */
const RESERVED_GLOBALS = new Set([...JS_GLOBALS, ...PI_HELPERS]);

/** Codex-only helpers with no Pi sandbox equivalent. */
const CODEX_HELPERS = new Set(["audio", "generatedImage", "notify", "yield_control", "setTimeout", "clearTimeout"]);

/** Cloudflare's `sanitizeToolName`: a tool name -> the identifier its sandbox uses. */
export function cloudflareSanitize(name: string): string {
  if (!name) return "_";
  let sanitized = name.replace(/[-.\s]/g, "_");
  sanitized = sanitized.replace(/[^a-zA-Z0-9_$]/g, "");
  if (!sanitized) return "_";
  if (/^[0-9]/.test(sanitized)) sanitized = "_" + sanitized;
  if (JS_RESERVED.has(sanitized)) sanitized = sanitized + "_";
  return sanitized;
}

/** Best-effort inverse of `cloudflareSanitize` for when no catalog is available. */
export function cloudflareUnsanitize(identifier: string): string {
  if (identifier.endsWith("_") && JS_RESERVED.has(identifier.slice(0, -1))) {
    return identifier.slice(0, -1);
  }
  if (/^_[0-9]/.test(identifier)) return identifier.slice(1);
  return identifier;
}

interface CloudflareCatalog {
  readonly catalog: Catalog;
  /** `cloudflareSanitize(name)` -> name. */
  readonly sanitized: ReadonlyMap<string, string>;
}

function buildCloudflareCatalog(names: readonly string[]): CloudflareCatalog {
  const catalog = buildCatalog(names);
  const sanitized = new Map<string, string>();
  for (const name of names) {
    const key = cloudflareSanitize(name);
    if (!sanitized.has(key)) sanitized.set(key, name);
  }
  return { catalog, sanitized };
}

/**
 * Resolve a Cloudflare path to a Pi identifier: exact separators, then the
 * Cloudflare-sanitized spelling, then a fuzzy `normalizeToolKey` match, then a
 * deterministic flatten.
 */
function resolveCloudflarePath(segments: readonly string[], catalog: CloudflareCatalog): Resolution {
  const path = segments.join(".");
  const candidates = [path, segments.join("__"), segments.join("_"), segments.join("/"), segments.join("-")];
  for (const candidate of candidates) {
    const matched = catalog.catalog.identifiers.get(toCodemodeIdentifier(candidate));
    if (matched !== undefined) return { identifier: toCodemodeIdentifier(matched), matched };
  }

  const sanitizedMatch = catalog.sanitized.get(cloudflareSanitize(path));
  if (sanitizedMatch !== undefined) {
    return { identifier: toCodemodeIdentifier(sanitizedMatch), matched: sanitizedMatch };
  }

  const key = normalizeToolKey(path);
  const fuzzy = key === "" ? undefined : catalog.catalog.normalized.get(key);
  if (fuzzy !== undefined) return { identifier: toCodemodeIdentifier(fuzzy), matched: fuzzy };

  return { identifier: toCodemodeIdentifier(cloudflareUnsanitize(segments[segments.length - 1] ?? "")) };
}

// ---------------------------------------------------------------------------
// TanStack scope analysis
// ---------------------------------------------------------------------------

/** TanStack's binding prefix for tools exposed inside the sandbox. */
export const TANSTACK_BINDING_PREFIX = "external_";

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

/** Whether `node` sits inside `container`'s source range. */
function within(node: AstNode, container: AstNode | undefined | null): boolean {
  if (!container) return false;
  return node.start >= container.start && node.end <= container.end;
}

function isFunctionScope(node: AstNode): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** Whether a binding pattern (parameter, declarator id) binds `name`. */
function patternBinds(pattern: AstNode | undefined | null, name: string): boolean {
  if (!pattern) return false;
  let found = false;
  const visit = (node: AstNode | undefined | null): void => {
    if (!node || found) return;
    switch (node.type) {
      case "Identifier":
        if (node.name === name) found = true;
        break;
      case "ObjectPattern":
        for (const property of (node.properties as AstNode[] | undefined) ?? []) {
          visit(property.type === "Property" ? (property.value as AstNode) : (property.argument as AstNode));
        }
        break;
      case "ArrayPattern":
        for (const element of (node.elements as (AstNode | null)[] | undefined) ?? []) visit(element);
        break;
      case "AssignmentPattern":
        visit(node.left as AstNode);
        break;
      case "RestElement":
        visit(node.argument as AstNode);
        break;
      default:
        break;
    }
  };
  visit(pattern);
  return found;
}

/**
 * Whether a function/Program scope declares `name` anywhere in its own body:
 * its parameters, `var`/`let`/`const` declarators, and nested function/class
 * declarations — without descending into nested functions (their bindings
 * belong to their own scopes). Declarations in sibling blocks are included,
 * which over-approximates slightly — the safe direction, since an
 * over-suppressed reference is left alone, never corrupted.
 */
function scopeDeclares(scope: AstNode, name: string): boolean {
  if (scope.type === "FunctionDeclaration") {
    const id = scope.id as AstNode | undefined;
    if (id?.type === "Identifier" && id.name === name) return true;
  }
  if (isFunctionScope(scope)) {
    for (const param of (scope.params as AstNode[] | undefined) ?? []) {
      if (patternBinds(param, name)) return true;
    }
  }
  let found = false;
  const visit = (node: AstNode): void => {
    if (found) return;
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      const id = node.id as AstNode | undefined;
      if (id?.type === "Identifier" && id.name === name) found = true;
      return; // nested scope — only the declaration name binds here
    }
    if (
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "ClassExpression"
    ) {
      return;
    }
    if (node.type === "VariableDeclarator") {
      if (patternBinds(node.id as AstNode, name)) found = true;
      return;
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(isFunctionScope(scope) ? ((scope.body as AstNode) ?? scope) : scope);
  return found;
}

/**
 * Whether `name` is shadowed at `node`'s position: declared by an enclosing
 * function/Program scope, bound by an enclosing parameter or catch parameter,
 * or being declared right there (a declaration site is never a reference).
 * Scope-aware, so a binding in one function does not suppress an unrelated
 * rewrite somewhere else in the script.
 */
function isShadowedAt(node: AstNode, parents: readonly AstNode[], name: string): boolean {
  for (let i = parents.length - 1; i >= 0; i--) {
    const ancestor = parents[i]!;
    if (ancestor.type === "VariableDeclarator") {
      if (within(node, ancestor.id as AstNode | undefined)) return true;
      continue;
    }
    if (ancestor.type === "CatchClause") {
      if (within(node, ancestor.param as AstNode | undefined)) return true;
      if (patternBinds(ancestor.param as AstNode, name)) return true; // node is inside the catch body
      continue;
    }
    if (
      ancestor.type === "FunctionDeclaration" ||
      ancestor.type === "FunctionExpression" ||
      ancestor.type === "ArrowFunctionExpression"
    ) {
      if (within(node, ancestor.id as AstNode | undefined)) return true;
      if (scopeDeclares(ancestor, name)) return true;
      continue;
    }
    if (ancestor.type === "ClassDeclaration" && within(node, ancestor.id as AstNode | undefined)) return true;
    if (ancestor.type === "Program" && scopeDeclares(ancestor, name)) return true;
  }
  return false;
}

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

/** Keep the outermost non-overlapping replacements: an inner `tools.a.b` inside `tools.a.b.c` is dropped. */
function selectReplacements(candidates: readonly Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => a.start - b.start || b.end - a.end);
  const chosen: Candidate[] = [];
  let lastEnd = -1;
  for (const candidate of sorted) {
    if (candidate.start < lastEnd) continue;
    chosen.push(candidate);
    lastEnd = candidate.end;
  }
  return chosen;
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
      const method = chain.segments[0]!;
      if (chain.segments.length === 1 && method === "search") {
        push(node, CLOUDFLARE_SEARCH_SHIM, "cloudflare");
        return;
      }
      if (chain.segments.length === 1 && method === "describe") {
        push(node, CLOUDFLARE_DESCRIBE_SHIM, "cloudflare");
        return;
      }
      if (chain.segments.length === 1 && (method === "run" || method === "step")) {
        warn(`codemode.${method}`, `\`codemode.${method}\` has no Pi equivalent; left unchanged`);
        return;
      }
      if (chain.segments.length > 1) {
        warn(
          `codemode.path:${chain.segments.join(".")}`,
          `unexpected Cloudflare \`codemode.${chain.segments.join(".")}\` path; left unchanged`,
        );
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
      if (name === "ToolCallError" && enabled("ptc")) {
        warn(
          "ptc:ToolCallError",
          "`ToolCallError` is PTC-only and undefined in Pi; catch the plain rejection value instead",
        );
      }
      if (enabled("codex") && CODEX_HELPERS.has(name) && isReferenceIdentifier(node, parents) && !bound.has(name)) {
        warn(
          `codex:${name}`,
          name === "audio"
            ? "`audio()` is Codex-only: Pi's codemode sandbox has no audio output"
            : name === "generatedImage"
              ? "`generatedImage()` is Codex-only; append the image with Pi's `image(block)` instead"
              : name === "notify"
                ? "`notify()` is Codex-only: Pi has no out-of-band notification, use `console.log(...)`"
                : name === "yield_control"
                  ? "`yield_control()` is Codex-only: Pi streams output when the script ends"
                  : `\`${name}()\` is Codex-only: Pi's QuickJS sandbox has no timers`,
        );
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

  const ordered = [...chosen].sort((a, b) => b.start - a.start);
  let result = code;
  for (const replacement of ordered) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return { code: result, changed: true, rewrites: chosen.length, warnings, groups };
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
