# Context — pi-codemode-guard

A glossary of the codemode contract and of the model mistakes this extension
repairs. This is the reference for "correct way vs wrong way".

## Codemode in one paragraph

`codemode` lets the model write one JavaScript script that calls pi's other
tools (and non-LLM models). Only the script's output reaches the model, so a
script can run calls in parallel, chain them, and filter large results. The
script runs as the **body of an async function** in a QuickJS sandbox: top-level
`await` and `return` work, and there is no Node, filesystem, network, or timers.

## Correct way

The tool input is exactly `{ code: <raw JavaScript> }`. The JavaScript:

- starts with an optional first line `// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}`;
- calls tools as `await tools.<identifier>({ ...args })`;
- uses `async`-only lookup helpers with `await`: `searchTools`, `describeTool`, `describeNamespace`;
- uses `await` on every `models.*` method (`getModelsOfType`, `getAvailableOfType`, `getModelOfType`, `classify`, `generateImages`);
- emits output with `text(value)`, `image(value)`, `console.log(...)`, or top-level `return value`;
- treats `ALL_TOOLS` as `{ name, description }[]`, not `string[]`;
- addresses tools by their codemode identifier: every character that is not
  valid in a JavaScript identifier becomes `_` (`mcp__dev-radius__search` →
  `tools.mcp__dev_radius__search`).

Hello world:

```js
const file = await tools.read({ path: "package.json" });
return JSON.parse(file).name;
```

Fan-out:

```js
const [a, b] = await Promise.all([tools.read({ path: "a.txt" }), tools.read({ path: "b.txt" })]);
text(`${a.length} + ${b.length} bytes`);
```

## Wrong way (what the guard repairs)

| Wrong input | Why it fails | Pass that fixes it |
|---|---|---|
| `"const x = 1;"` as the whole `code` value | pi validates `code` as an object field; the whole call is rejected | `arguments.ts` (prepareArguments) |
| `{ script: "..." }`, `{ source: "..." }`, `{ input: "..." }` | wrong field name → `code` missing → validation error | `arguments.ts` |
| `{ code: { language: "js", content: "..." } }` | `code` must be a string | `arguments.ts` |
| `[{ "tool": "read", "args": { "path": "a" } }]` | not JavaScript | `compile-json-program` |
| ` ```js … ``` ` fences, sometimes with prose | fences are not valid JavaScript | `strip-code-fence` |
| `// @options {"max_output_tokens": 2000}` (no colon) | not the exact `// @options:` prefix | `normalize-options-line` |
| `/* @options: {'maxOutputTokens': 2000} */` | block comment + single quotes + camelCase field | `normalize-options-line` |
| `(async () => { … })();` | redundant wrapper; unawaited it may never run | `unwrap-iife` |
| `const hits = searchTools("x");` | promise serialized as `{}` (pi issue #10555) | `await-async-calls` |
| `const r = tools.bash({ command: "ls" });` | unawaited promise, results never used | `await-async-calls` |
| `tools["mcp__dev-radius__search"]({…})` | bracket access with the raw name, or a syntax error for `-` | `rewrite-tool-identifiers` |

The three observed real-world failures this extension exists for:

1. **Unawaited async lookup helpers** — a session printed `feishu: {}` because
   `searchTools('feishu', { limit: 20 })` was not awaited. Pi later fixed the
   *description* to say `await searchTools(...)` (commit `269121616`, issue
   #10555); the guard fixes scripts from every model, including ones that still
   omit it.
2. **`ALL_TOOLS` treated as strings** — a session did
   `ALL_TOOLS.filter(n => /gitee/.test(n))` and got `[]`, because `ALL_TOOLS`
   elements are objects. The guard does not rewrite this (it is semantically
   ambiguous), but it is documented here so prompts/agents can.
3. **JSON tool-call programs** — models that cannot write JavaScript emit the
   calls as JSON; the guard compiles them.

## OpenCode dialect (`@opencode-ai/codemode`)

OpenCode's `packages/codemode` has the **same `{ code }` envelope** but a
different program API. `detectCodemodeDialect` flags it from `$codemode`, a
`tools.<ns>.<tool>` path (Pi tools are single-level), or `Object.keys(tools)`.
`compileOpencodeDialect` then rewrites:

| OpenCode | Pi |
|---|---|
| `tools.orders.lookup({ id })` | `tools.orders_lookup({ id })` |
| `tools.context7["resolve-library-id"]({ name })` | `tools.context7_resolve_library_id({ name })` |
| `tools.mcp.dev.radius.search({ query })` | `tools.mcp__dev_radius__search({ query })` |
| `await tools.$codemode.search({ query, namespace, limit, offset })` | `await searchTools(...)` shim returning `{ items: [{ path, description, signature }], remaining, next }` |
| `Object.keys(tools)` | `ALL_TOOLS.map((t) => t.name)` |

Compatible already, so untouched: `return value`, `console.log` (Pi uses
`<console_output>`; OpenCode collects `logs`), `Promise.all`/`allSettled`/`race`,
and top-level `await`. OpenCode forbids `.then/.catch/.finally`; Pi allows them,
so OpenCode → Pi is a superset.

Name resolution needs Pi's live catalog: the extension passes
`pi.getAllTools().map((t) => t.name)`. Exact separators are tried first, then a
fuzzy `normalizeToolKey` match (`mcp.dev.radius.search` ↔
`mcp__dev-radius__search`), then a deterministic flatten plus a `warning`.

## Cloudflare dialect (`@cloudflare/codemode`)

Cloudflare's `packages/codemode` in the `cloudflare/agents` repo also shares the
`{ code }` envelope, but the whole program is a bare `async () => { … }` wrapper
and tools live on namespaces:

| Cloudflare | Pi |
|---|---|
| `async () => { … }` | the body (`unwrap-iife` already strips the wrapper) |
| `codemode.lookupOrder({ … })` | `tools.lookupOrder({ … })` — the default `codemode` namespace is stripped |
| `state.readFile("/path")` | `tools.state_readFile("/path")` — named provider, only when the live catalog confirms it |
| `await codemode.search("query")` | an `await searchTools(...)` shim returning `{ results: [{ path, connector, method, description, kind }], total, truncated }` |
| `await codemode.describe(path)` | an `await describeTool(...)` shim returning `{ path, description, types }` |
| `codemode.run(name)` / `codemode.step(name, fn)` | no Pi equivalent — left unchanged with a `warning` |
| `Math`/`JSON`/`console`/`Promise`/`Object`/`searchTools`, … | never a provider namespace |

Cloudflare's naming rule (`sanitizeToolName`) differs from Pi's
`toCodemodeIdentifier`: it strips invalid characters instead of replacing them,
prefixes digit-leading names (`3d-render` → `_3d_render`), and suffixes reserved
words (`delete` → `delete_`). The catalog is therefore keyed by both spellings,
so `codemode.delete_()` maps back to `tools.delete()` and `codemode._3d_render()`
to `tools._d_render()`. Names bound by the script (`const state = { … }`) and
unresolved providers are left untouched (the latter with a `warning` when a
catalog is present); positional provider arguments are preserved verbatim because
the compiler cannot know Pi's parameter names.

## TanStack AI code mode dialect (`@tanstack/ai-code-mode`)

TanStack's `createCodeModeTool` shares the `{ code }` envelope (its input field is
`typescriptCode`, accepted as an alias), but the sandbox is different: tools are
global `external_<tool>` async functions and the source is TypeScript, not
JavaScript. Pi's sandbox is QuickJS running plain JavaScript, so the guard:

| TanStack AI code mode | Pi |
|---|---|
| `{ typescriptCode: "…" }` | `{ code: "…" }` (the `typescriptCode` alias) |
| `external_getWeather({ … })` | `tools.getWeather({ … })` — prefix stripped, rest resolved against the live catalog |
| `external_my_tool({ … })` with tool `my-tool` | `tools.my_tool({ … })` (Pi's `toCodemodeIdentifier` rule) |
| TypeScript (annotations, interfaces, `as`, generics) | plain JavaScript (stripped via sucrase before the script is parsed) |
| `return value`, `console.log`, `Promise.all`, top-level `await` | already valid Pi — left untouched |

The catalog mapping and fallback (exact → fuzzy `normalizeToolKey` → flatten +
`warning`) are the same ones `resolveToolPath` uses for OpenCode.

## Pipeline (high level)

```
provider tool call / model answer
        │
        ▼
prepareArguments (arguments.ts)      ← runs before pi validation
  raw string? alias field? JSON program?
        │  { code }
        ▼
pi validates { code: string }
        │
        ▼
tool_call event (index.ts)
  compile.ts
    1 strip-code-fence
    2 normalize-options-line
    3 compile-json-program
    4 unwrap-iife
    5 opencode-dialect      (only when the dialect is opencode)
    6 cloudflare-dialect    (only when the dialect is cloudflare)
    7 tanstack-typescript   (only when the dialect is tanstack: strip TypeScript syntax)
    8 tanstack-dialect      (only when the dialect is tanstack: external_<tool> -> tools.*)
    9 await-async-calls
   10 rewrite-tool-identifiers
        │  compiled code
        ▼
codemode sandbox executes the script
        │
        ▼
tool_result event → details.piCodemodeGuard + compile receipt
```

## Why some things are deliberately *not* fixed

- **`ALL_TOOLS.filter(n => /x/.test(n))`** — rewriting element access changes
  program semantics; the guard would have to guess the model's intent.
- **Missing `await` inside a non-async function** — inserting `await` there is a
  syntax error, so the pass skips non-async function scopes.
- **`Promise.all([tools.a()])`** — the combinator already awaits, so the pass
  must not add `await` to its members.
- **Envelope shapes after validation** — pi validates before any execution hook,
  which is why the argument normalization has to live in `prepareArguments`
  (installed through the tool proxy), not in `tool_call`.

## Glossary

- **codemode identifier** — the `tools.<id>` name, produced by
  `toCodemodeIdentifier` (`identifiers.ts`).
- **prepareArguments** — pi tool-definition hook that runs before schema
  validation and may return corrected arguments.
- **tool_call event** — pi event fired after validation; `event.input` is
  mutable and is not re-validated.
- **pass** — one best-effort compiler transformation, identified in `passes`.
- **dialect** — `pi`, `opencode`, `cloudflare`, `tanstack`, or `unknown`; OpenCode is the
  `@opencode-ai/codemode` program API (nested tool paths, `$codemode.search`),
  Cloudflare is the `@cloudflare/codemode` API (`codemode.*`, named providers,
  bare `async () => { … }` wrapper), TanStack is `@tanstack/ai-code-mode`
  (`external_<tool>` bindings in TypeScript source).
- **catalog** — the Pi tool names (`pi.getAllTools()`), needed to collapse an
  OpenCode namespace path to Pi's flat identifier.
- **guard details** — `details.piCodemodeGuard`, the versioned record of what
  the compiler changed.
