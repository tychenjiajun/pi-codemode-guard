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
| `const n: number = 1;` as a whole script (no dialect claimed it) | acorn cannot parse TypeScript | `strip-typescript` (generic fallback, then re-detect the dialect) |
| `(async () => { … })();` | redundant wrapper; unawaited it may never run | `unwrap-iife` |
| `const hits = searchTools("x");` | promise serialized as `{}` (pi issue #10555) | `await-async-calls` |
| `const r = tools.bash({ command: "ls" });` | unawaited promise, results never used | `await-async-calls` |
| `tools["mcp__dev-radius__search"]({…})` | bracket access with the raw name, or a syntax error for `-` | `rewrite-tool-identifiers` (and `vercel-dialect` for Vercel source) |

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

## OpenCode dialect (`@opencode-ai/codemode`, https://github.com/anomalyco/opencode/tree/dev/packages/codemode)

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
| `Object.keys(tools.<ns>)` | the same name list filtered by the namespace's identifier prefix (plain and `mcp__` spellings) |
| `for...in tools.<ns>` | not rewritten — warns and is left as is |

Compatible already, so untouched: `return value`, `console.log` (Pi uses
`<console_output>`; OpenCode collects `logs`), `Promise.all`/`allSettled`/`race`,
and top-level `await`. OpenCode forbids `.then/.catch/.finally`; Pi allows them,
so OpenCode → Pi is a superset.

Name resolution needs Pi's live catalog: the extension passes
`pi.getAllTools().map((t) => t.name)`. Exact separators are tried first (each
also tried under the MCP `mcp__` prefix), then a fuzzy `normalizeToolKey` match (`mcp.dev.radius.search` ↔
`mcp__dev-radius__search`), then a deterministic flatten plus a `warning`.

## Cloudflare dialect (`@cloudflare/codemode`, https://github.com/cloudflare/agents/tree/main/packages/codemode)

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

## TanStack AI code mode dialect (`@tanstack/ai-code-mode`, https://github.com/TanStack/ai/tree/main/packages/ai-code-mode)

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

## Vercel AI SDK code mode dialect (`@ai-sdk/code-mode`, https://github.com/vercel/ai/tree/main/packages/code-mode)

Vercel's `@ai-sdk/code-mode` (vercel/ai, packages/code-mode) does **not** share
the `{ code }` envelope: the program arrives as `{ js: "…" }` (`js` is already
accepted as an argument alias) and runs as the body of an async function, so
top-level `await`/`return` work. The source is TypeScript and raw tool names
that are not valid JS identifiers keep bracket access. Pi's sandbox is QuickJS
running plain JavaScript with flat `tools.<identifier>` names, so the guard:

| Vercel AI code mode | Pi |
|---|---|
| `{ js: "…" }` | `{ code: "…" }` |
| `await tools["web-search"]({ q })` | `await tools.web_search({ q })` |
| `const c: string = "London";` | `const c = "London";` |
| `tools.getWeather({ location })` | `tools.getWeather({ location })` (unchanged) |

`vercel-typescript` strips the TypeScript syntax (interfaces, annotations,
`satisfies`) via sucrase **before** `unwrap-iife` runs, then
`compileVercelDialect(code, { tools })` maps `tools["raw-name"]` to
`tools.<identifier>` using Pi's live catalog. Unresolved names are flattened
deterministically and reported in `warnings`, using the same exact → fuzzy
`normalizeToolKey` → flatten fallback as OpenCode. There are no
`searchTools` / `ALL_TOOLS` / `codemode.*` helpers in this dialect — tool
discovery is embedded in the tool description — so nothing is shimmed.

**Detection.** `detectCodemodeDialect` reports `vercel:tools.<name>` when the
source is TypeScript (acorn cannot parse it), references `tools`, and carries no
OpenCode/TanStack/Cloudflare signal. TanStack (`external_`) and OpenCode
(`$codemode` / nested `tools.<ns>.<tool>`) signals are checked first and take
priority.

## DeepSeek Harness PTC dialect (`@deepseek-ai/dsh-ptc-runtime-node`)

DeepSeek's harness PTC mode (`deepseek-ai/deepseek-harness`,
packages/ptc-runtime/ptc-runtime-node) exposes a `run_code({ description, code })`
tool. Pi's codemode tool takes `{ code }`; the argument-normalization shim reads
only `code` (or an alias field), so the extra `description` field is ignored.
`code` is the body of an async
TypeScript function (erasable TypeScript only), so top-level `await`/`return`
work. Host functions are exposed as a global `tools` object whose function
names are arbitrary strings; `console.log(...)` and `return` are PTC's output
channels and are Pi-compatible.

| DeepSeek PTC | Pi codemode |
|---|---|
| `{ code, description }` | `{ code }` (`description` ignored) |
| `await tools["web-search"]({ q })` | `await tools.web_search({ q })` — resolved against the live catalog |
| `Object.keys(tools)` | `ALL_TOOLS.map((t) => t.name)` |
| `const c: string = "London";` | `const c = "London";` — TypeScript stripped via sucrase |
| `ToolCallError` | no equivalent — a warning is emitted |
| `await import("node:fs")` | unavailable in Pi — a warning is emitted |

Model-written calls use `await tools.name(args)`, with quoted access
`tools["my-tool"](args)` for exotic names, whereas Pi uses `tools.<identifier>`
with every invalid character replaced by `_` —
`compilePtcDialect(code, { tools })` (see `ptc.ts`) rewrites them against the
live catalog. Failed tool calls in PTC reject with `ToolCallError` (a PTC-only
global with `.toolName`); Pi has no equivalent (a failed call rejects with a
plain `Error`). PTC reaches Node APIs with `await import(...)`, while Pi's
QuickJS sandbox has no `import`, `fetch`, or Node APIs. The pipeline runs
`ptc-typescript` (sucrase) **before** `unwrap-iife`, then `ptc-dialect(N)`.

**Detection.** `detectCodemodeDialect` reports PTC from `ptc:ToolCallError`,
`ptc:import()`, and — only when acorn cannot parse the TypeScript —
`ptc:Object.keys(tools)`. OpenCode's structural signals (`$codemode`, nested
`tools.<ns>.<tool>`), TanStack, and Cloudflare take priority; PTC's own signals
outrank the generic `Object.keys(tools)` shape that OpenCode also uses. Vercel
remains the generic TypeScript fallback, so a PTC program with none of these
signals is still compiled correctly as `vercel`.

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
    4 tanstack-typescript   (only when the dialect is tanstack: strip TypeScript syntax)
    5 vercel-typescript     (only when the dialect is vercel: strip TypeScript syntax)
    6 ptc-typescript        (only when the dialect is ptc: strip TypeScript syntax)
    7 strip-typescript      (only when the dialect is unknown and acorn cannot parse: generic TS fallback, then re-detect)
    8 unwrap-iife
    9 opencode-dialect      (only when the dialect is opencode)
   10 cloudflare-dialect    (only when the dialect is cloudflare)
   11 tanstack-dialect      (only when the dialect is tanstack: external_<tool> -> tools.*)
   12 vercel-dialect        (only when the dialect is vercel: tools["raw-name"] -> tools.<identifier>)
   13 ptc-dialect           (only when the dialect is ptc: raw tool names -> tools.<identifier>, Object.keys(tools) -> ALL_TOOLS)
   14 await-async-calls
   15 rewrite-tool-identifiers   (catalog-aware: resolves the written raw name against `tools` first)
        │  compiled code
        ▼
codemode sandbox executes the script
        │
        ▼
tool_result event → details.piCodemodeGuard + compile receipt
```

A JSON program (pass 3) is compiler-generated JavaScript: it skips passes 4–13
and runs only `await-async-calls` and `rewrite-tool-identifiers` on the result.

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
- **dialect** — `pi`, `opencode`, `cloudflare`, `tanstack`, `vercel`, `ptc`, or `unknown`; OpenCode is the
  `@opencode-ai/codemode` program API (nested tool paths, `$codemode.search`),
  Cloudflare is the `@cloudflare/codemode` API (`codemode.*`, named providers,
  bare `async () => { … }` wrapper), TanStack is `@tanstack/ai-code-mode`
  (`external_<tool>` bindings in TypeScript source), Vercel is
  `@ai-sdk/code-mode` (`{ js }` envelope, TypeScript source, bracket access
  `tools["raw-name"]`), DeepSeek Harness PTC is
  `@deepseek-ai/dsh-ptc-runtime-node` (`run_code({ description, code })`,
  global `tools` with arbitrary raw names, TypeScript source). Detection runs as
  `detectCodemodeDialect(code, { hadOptionsLine })` — the flag restores the
  `@options` signal that `normalize-options-line` removed.
- **catalog** — the Pi tool names (`pi.getAllTools()`), passed into the compiler
  as data so catalog-aware passes (OpenCode namespace paths, Vercel/PTC raw
  names, `rewrite-tool-identifiers` bracket access) can collapse them to Pi's
  flat identifiers.
- **pending compilation record** — the `tool_call` → `tool_result` pairing kept
  in `index.ts`, capped at 32 FIFO entries (`MAX_PENDING_RECORDS`) so a turn
  aborted between the events cannot leak memory; a late result for an evicted
  call goes unstamped.
- **guard status footer** — `showGuardStatus(...)` in `ui.ts`: a transient
  footer status that only runs in TUI mode (`ctx.mode === "tui"` with `ctx.ui`
  present) and clears itself after a few seconds.
- **guard details** — `details.piCodemodeGuard`, the versioned record of what
  the compiler changed.
