# Agent Instructions

## Package Manager
- Use **pnpm**: `pnpm install`

## Commands
| Task | Command |
|------|---------|
| Run all tests | `pnpm test` |
| Type check | `pnpm typecheck` |
| Run a single test file | `pnpm vitest run src/dialect/detect.test.ts` |

## Key Conventions
- This is a **pi extension** — entry point is `src/index.ts` (declared in `package.json` under `pi.extensions`)
- Source lives under `src/`, grouped into `core/` (pure AST/catalog infrastructure), `passes/` (the string → string compile passes) and `dialect/` (detection + translation). Tests are `*.test.ts` alongside the module they cover; shared fixtures live in `src/test-support.ts`
- Keep the compiler **pure**: every pass in `src/passes/` takes a string and returns a string; no I/O, no pi state. Passes that need the tool catalog get it as a name list (`translateCodemode(code, { tools, dialect })`, `rewriteToolIdentifiers(code, tools?)`, `compileCodemodeSource(input, { tools })`), so they stay data-only
- A compile pass must be **best-effort and idempotent**: `compile(compile(x)) === compile(x)`, and an unparseable script is returned unchanged (with a warning) instead of throwing
- Translation is **statement-based**, not whole-snippet: `translateCodemode` parses once and repairs each construct by its shape, so a snippet that mixes dialects is fully translated. Do not reintroduce a single-dialect `if/else` in `compile.ts`; add a rule to `dialect/translate.ts` instead
- Use `vi`/fixtures for time-dependent or UI tests; mock `pi` and `ctx.ui` as `index.test.ts` does

## Architecture

```
src/
  index.ts            pi extension entry (tool proxy + tool_call/tool_result hooks)
  arguments.ts        prepareArguments normalization
  compile.ts          the pipeline
  contract.ts         details.piCodemodeGuard interop contract
  ui.ts               compile receipt + transient footer status
  test-support.ts     shared test fixtures
  core/               pure infrastructure shared by every pass
  passes/             the string -> string compile passes
  dialect/            dialect detection + statement translation
```

Root files:
- `index.ts` — Extension entry. Runs `createCodemodeExtension()` through a `pi` proxy that adds `prepareArguments` to the codemode tool; compiles validated `code` in the `tool_call` handler; stamps `details.piCodemodeGuard` in `tool_result`
- `arguments.ts` — Pre-validation argument normalization (`prepareArguments` shim): raw string, alias fields, nested source, JSON programs
- `compile.ts` — The compiler pipeline (fences → options → JSON program → dialect TypeScript → generic strip-typescript → IIFE → statement translation → await → identifiers) and the public `CompileOptions`/`CompileResult`
- `contract.ts` — Versioned `details.piCodemodeGuard` interop contract
- `ui.ts` — Compile receipt + transient footer status

`core/` — pure, dialect-agnostic infrastructure (no rewriting):
- `parse.ts` — Shared acorn parsing helpers (`parseScript`, `childNodes`, `walk`, `memberPropertyName`, `isFunctionNode`)
- `scope.ts` — Scope/binding analysis (`collectBoundNames`, `isShadowedAt`, `isReferenceIdentifier`, `isDeclarationPosition`), shared by detection, translation and the await pass
- `catalog.ts` — Tool catalog (`buildCatalog`) and catalog-aware path resolution (`resolveToolPath`, with dialect hooks for an alternate spelling and a fallback)
- `cloudflare-names.ts` — Cloudflare's `sanitizeToolName` rules and `resolveCloudflarePath` (a `resolveToolPath` built with Cloudflare's spelling as the alternate identifier)
- `replacements.ts` — Shared source-range replacement selection (`selectReplacements`) and splicing (`applyReplacements`)
- `identifiers.ts` — pi's `toCodemodeIdentifier` rule
- `pi-globals.ts` — The identifiers pi injects into the codemode sandbox (`PI_SANDBOX_GLOBALS`, `PI_LOOKUP_HELPERS`), shared by the await pass, the detector and the translator
- `shims.ts` — The inline runtime shims the translator splices in (`OPENCODE_SEARCH_SHIM`, `CLOUDFLARE_SEARCH_SHIM`/`DESCRIBE_SHIM`, `CODEMODE_KEYS_SHIM`, `namespaceKeysShim`) and the Cloudflare platform-method registry (`CLOUDFLARE_PLATFORM_SHIMS`/`_UNSUPPORTED`/`_METHODS`)
- `guards.ts` — `isRecord`
- `lexical.ts` — `stripComments` for the unparseable-TypeScript signal fallback

`passes/` — the compile passes, in pipeline order:
- `fences.ts` — Markdown fence stripping
- `options.ts` — `// @options:` / Codex `// @exec:` line normalization and field-alias mapping
- `loose-json.ts` — tolerant JSON repair for the options body
- `program.ts` — JSON tool-call programs → `await tools.<id>({...})` JavaScript
- `typescript.ts` — TypeScript syntax stripping via sucrase (TanStack's `execute_typescript`, Vercel's `{ js }`, DeepSeek PTC's `run_code`, and any stray TypeScript)
- `iife.ts` — Redundant async-IIFE unwrapping
- `await-inject.ts` — acorn-based missing-`await` repair (the pi #10555 bug)
- `rewrite.ts` — catalog-aware `tools["a-b"]` → `tools.a_b` identifier rewriting (`rewriteToolIdentifiers(code, tools?)`)

`dialect/` — detection and translation:
- `signals.ts` — Shared dialect vocabulary: the `CODEMODE_DIALECTS` list and `CodemodeDialect` type, `TANSTACK_BINDING_PREFIX`, and the `UNSUPPORTED_GLOBALS` table (dialect globals pi's sandbox lacks, with each row's warning message and distinctive-detection flag). The table is the single source of truth for both the detector's signals and the translator's warnings — add a dialect global there
- `detect.ts` — `detectCodemodeDialect(code, { hadOptionsLine, hadExecLine })` (pi/opencode/cloudflare/tanstack/vercel/ptc/codex/unknown); the context flags restore the pragma signals that pass 2's split removed
- `translate.ts` — The statement-based translator: one AST walk that applies every dialect's rewrite rules by construct shape (OpenCode namespace paths/`$codemode`, Cloudflare `codemode.*`/providers, TanStack `external_<tool>`, Vercel/PTC `tools["raw"]`, Codex-only helpers, bare tool calls). It also exports the single-dialect entry points (`compileOpencodeDialect`, `compileCloudflareDialect`, `compileTanstackDialect`, `compileVercelDialect`, `compilePtcDialect`, `compileCodexDialect`) — thin `only`-scoped wrappers kept for the isolated dialect tests — and re-exports `cloudflareSanitize`/`cloudflareUnsanitize` from `cloudflare-names.ts`. There are no per-dialect compiler modules; the rules live only here

## Why a tool proxy instead of an override
`prepareArguments` runs **before** pi validates tool arguments, so it is the only
place that can rescue a raw string, an alias field, or a JSON program. The
built-in codemode tool is registered by a **replaceable** inline extension, and
pi drops that extension when another extension registers a tool named
`codemode` during load. Reimplementing the tool would lose `models`, `store()`
persistence, and `codemode.mode`, so the guard instead runs the canonical
`createCodemodeExtension()` factory through a small proxy that augments the
definition. Keep it that way: do not fork the codemode implementation.

## Interop Contract
`details.piCodemodeGuard` (see `contract.ts`) is published on every codemode
result the guard compiled:

- `originalCode` — the source pi validated, before the compiler ran
- `compiledCode` — the source the sandbox received
- `passes` — applied pass ids in order, e.g. `["opencode-dialect(2)", "await-async-calls(2)"]`
- `parsed` — whether the compiler recognized the source
- `dialect` — `"pi"`, `"opencode"`, `"cloudflare"`, `"tanstack"`, `"vercel"`, `"ptc"`, `"codex"`, or `"unknown"`
- `warnings` — non-fatal problems (e.g. a dropped `@options` line or an unresolved OpenCode/Vercel tool path). `translate.ts` deduplicates repeated warnings by key: unresolved tool paths / providers are collapsed per identifier or path (so `tools["nope"]` twice yields one warning), and each Codex/PTC helper warns once

Consumers must parse via `readPiCodemodeGuardDetails` and fall back to the inline
content for unknown versions. The shape is additive-only; `dialect` and unknown
fields are ignored by older readers.

## Compile passes
Passes run in this order and each may be skipped independently:

1. `strip-code-fence`
2. `normalize-options-line`
3. `compile-json-program`
4. `tanstack-typescript` / `vercel-typescript` / `ptc-typescript` — when the detected dialect is `tanstack`, `vercel`, or `ptc`; strips TypeScript syntax via sucrase before `unwrap-iife` can parse it
5. `strip-typescript` — generic TypeScript fallback: only when the dialect is `unknown` and acorn cannot parse the script; best-effort sucrase strip, then the dialect is re-detected (never runs after a dialect TypeScript pass already ran)
6. `unwrap-iife`
7. `translate-statements` — one statement-based pass over every dialect construct, with a `<dialect>-dialect(N)` id per group that fired (`opencode`, `cloudflare`, `tanstack`, `vercel`, `ptc`, `codex`, `bare`)
8. `await-async-calls(N)` — insert missing `await` on `tools.*`/lookup helpers
9. `rewrite-tool-identifiers` — `tools["a-b"]` → `tools.a_b`; catalog-aware: with `options.tools` given, the written raw name resolves through `resolveToolPath` first, otherwise the naive `toCodemodeIdentifier` is used

A JSON program (pass 3) is compiler-generated JavaScript: it skips the statement translation and runs only `await-async-calls` and `rewrite-tool-identifiers` on the generated script, so raw-JavaScript string steps still get awaited and rewritten.

## Statement translation (`translate.ts`)

`compileCodemodeSource` no longer picks one dialect and runs that dialect's
compiler. After the preamble passes it calls
`translateCodemode(body, { tools, dialect })`, which parses once and applies
**every** rule to **every** construct, in one walk. A snippet may therefore mix
dialects, and each statement is translated by its shape:

- `tools.<ns>.<tool>` → `tools.<identifier>` (OpenCode) — always, when the live catalog confirms the path, otherwise only when the detected dialect is OpenCode (so `tools.read.length` is never flattened)
- `tools.$codemode.search(...)` → `OPENCODE_SEARCH_SHIM`; other `$codemode.*` warn
- `codemode.search`/`codemode.describe` → Cloudflare shims; `codemode.run`/`step` and deep `codemode.*` paths warn; `codemode.<tool>` and named providers (`state.writeJson`) → `tools.<identifier>` when the catalog confirms them
- `external_<tool>` → `tools.<identifier>` (TanStack), scope-aware so a local/parameter binding is left alone
- `tools["raw-name"]` → `tools.<identifier>` (Vercel/PTC) — only for the vercel/ptc dialect (plain JavaScript brackets are handled by `rewrite-tool-identifiers`, warning-free)
- `Object.keys(tools)` → `ALL_TOOLS.map((t) => t.name)`; the spelling (`__cm_tool` vs `__ptc_tool`) and the `Object.keys(tools.<ns>)` behavior follow the detected dialect (OpenCode filters, PTC warns)
- `for...in tools.<ns>` → opencode warning
- Codex-only helpers (`audio`, `generatedImage`, `notify`, `yield_control`, `setTimeout`, `clearTimeout`) → warnings, guarded by local bindings
- bare `search(...)` where `search` is a live catalog tool and is not shadowed → `tools.search(...)` (the `bare` group)

The detected `dialect` is still passed in, but only to pick the TypeScript pass,
to disambiguate the two constructs OpenCode and PTC share (`Object.keys(tools)`
and unresolved bracket names), and for the interop contract. `compile.ts`
reports `translate-statements` plus a `<dialect>-dialect(N)` pass id per group
that fired, so one compile can list several dialect passes.

Apply order and ownership: a single candidate list is collected, then the
outermost non-overlapping replacements win (an inner `tools.a.b` inside
`tools.a.b.c` is dropped), and replacements are spliced back to front. Every
rule is idempotent by shape, so `compile(compile(x)) === compile(x)`.

## OpenCode dialect (`@opencode-ai/codemode`, https://github.com/anomalyco/opencode/tree/dev/packages/codemode)
The `tools.<ns>.<tool>` → `tools.<identifier>` mapping needs Pi's live catalog,
so `compileCodemodeSource(input, { tools: pi.getAllTools().map((t) => t.name) })`
must be given it. Resolution order: exact separators (`.`, `__`, `_`, `/`, `-`),
each also tried with the MCP `mcp__` prefix, then a fuzzy `normalizeToolKey`
match (with and without `mcp_`), then a deterministic flatten with a warning.
`tools.$codemode.search(...)` becomes an inline `searchTools(...)` shim echoing
OpenCode's `{ items, remaining, next }` shape. `Object.keys(tools)` becomes
`ALL_TOOLS.map((t) => t.name)`; `Object.keys(tools.<ns>)` is rewritten to that
list filtered by the namespace's identifier prefix (both the plain and `mcp__`
spellings); `for...in tools.<ns>` is **not** rewritten — it warns and is left as
is. Keep the compiler pure: catalog names come in as data, not from pi inside
the module.

## Cloudflare dialect (`@cloudflare/codemode`, https://github.com/cloudflare/agents/tree/main/packages/codemode)
`@cloudflare/codemode` (in `cloudflare/agents`, packages/codemode) writes the
whole program as a bare `async () => { … }` wrapper, addresses tools through the
`codemode` platform namespace and named provider namespaces (`state.*`,
`github.*`), and uses `codemode.search`/`describe`. `unwrap-iife` removes the
wrapper before `compileCloudflareDialect` runs. `codemode.search` and
`codemode.describe` become inline `searchTools`/`describeTool` shims echoing
Cloudflare's shapes; `codemode.run`/`codemode.step` have no Pi equivalent and
warn. Named providers are only rewritten when the live catalog confirms them, so
JS globals and locally bound objects are never touched. Cloudflare's
`sanitizeToolName` (digit-leading prefix, reserved-word suffix) differs from Pi's
`toCodemodeIdentifier`, so the catalog is also keyed by the Cloudflare spelling.
Two known limitations: detection is catalog-free, so a statement-form program
that uses only named providers (no `codemode.*` call, no async-arrow wrapper)
reports `dialect: unknown` — but the provider rewrite still runs, because
`translate.ts` applies the Cloudflare rule to every statement when the catalog
is present; and `unwrap-iife` only
unwraps a lone **expression** statement, so `export default async () => {}` is
left in place (it is not an `async-arrow-wrapper` signal either).

## TanStack AI code mode dialect (`@tanstack/ai-code-mode`, https://github.com/TanStack/ai/tree/main/packages/ai-code-mode)
`@tanstack/ai-code-mode` takes `{ typescriptCode }` (accepted as an `arguments.ts`
alias) and runs each tool as a global `external_<tool>` async function in a TS
sandbox. `compileTanstackDialect` rewrites `external_<tool>(...)` →
`tools.<identifier>` against the live catalog (the same `resolveToolPath` used by
OpenCode). The source is TypeScript, so `stripTypeScriptSyntax` (`typescript.ts`,
via sucrase) runs first — before `unwrap-iife`, so a wrapped TS program still
unwraps. `external_*` identifiers the script itself declares are left untouched.

## Vercel AI SDK code mode dialect (`@ai-sdk/code-mode`, https://github.com/vercel/ai/tree/main/packages/code-mode)
`@ai-sdk/code-mode` (vercel/ai, packages/code-mode) sends the program in a
`{ js: string }` envelope — Pi uses `{ code }`, and `js` is already accepted as
an argument alias — and runs it as the body of an async function, so top-level
`await`/`return` work. Tools are called as `tools.<name>(input)`; raw tool names
that are not valid JS identifiers keep bracket access
(`tools["web-search"]({ q })`), whereas Pi uses `tools.<identifier>` with every
invalid character replaced by `_` (`tools.web_search({ q })`). The source is
TypeScript (interfaces, type annotations, `satisfies`) while Pi's QuickJS
sandbox is plain JavaScript, so `vercel-typescript` strips the types via sucrase
before `unwrap-iife`, and `compileVercelDialect(code, { tools })` rewrites
`tools["raw-name"]` → `tools.<identifier>` against the live catalog — unresolved
names warn and are flattened deterministically (the same `resolveToolPath`
fallback as OpenCode). Known behavior: a plain-JavaScript Vercel program parses,
so the `vercel:tools.<name>` TypeScript signal never fires and `vercel-dialect`
does not run — its exotic bracket access is still resolved against the catalog
by the shared `rewrite-tool-identifiers` pass, but without the unresolved-name
warning; and a toolless TypeScript program with zero signals now detects as
`unknown` and is rescued by the generic `strip-typescript` pass instead of
reaching the sandbox unparseable. There are no `searchTools` / `ALL_TOOLS` /
`codemode.*` helpers in this dialect; tool discovery is embedded in the tool
description.
Detection signal: `vercel:tools.<name>` — TypeScript source (acorn cannot parse
it) that references `tools` and carries no OpenCode/TanStack/Cloudflare signal;
TanStack (`external_`) and OpenCode (`$codemode` / nested `tools.<ns>.<tool>`)
take priority.

## DeepSeek Harness PTC dialect (`@deepseek-ai/dsh-ptc-runtime-node`, https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/ptc-runtime/ptc-runtime-node)
DeepSeek's PTC mode tool is `run_code({ description, code })`; Pi's codemode
tool takes `{ code }`, and `arguments.ts` reads only `code` (or an alias field),
so the extra `description` field is ignored rather than specially handled.
`code` is the body of an async TypeScript function
(erasable TypeScript only), so top-level `await`/`return` work. Host functions
are exposed as a global `tools` object whose names are arbitrary strings: the
model writes `await tools.name(args)` or quoted access
`await tools["my-tool"](args)`, and `compilePtcDialect(code, { tools })` rewrites
them to Pi's `tools.<identifier>` against the live catalog (the same
`resolveToolPath` fallback as OpenCode/Vercel). `Object.keys(tools)` lists tool
names and becomes `ALL_TOOLS.map((t) => t.name)`. The source is TypeScript, so
`ptc-typescript` strips the types via sucrase before `unwrap-iife`. A failed
tool call rejects with `ToolCallError` (a PTC-only global with `.toolName`) —
Pi has no equivalent (a failed call rejects with a plain `Error`), so it warns;
`await import(...)` reaches Node APIs Pi's QuickJS sandbox does not have, so that
warns too. Only those two warn: `fetch`, `process`, and `require` are not
detected — known limitation, they are unavailable in the sandbox and fail at
runtime instead of producing a warning. `console.log(...)` and `return` are
PTC's output channels and are Pi-compatible.

Detection signal: `ptc:ToolCallError`, `ptc:import()`, and
`ptc:Object.keys(tools)` — the last only when acorn cannot parse the
TypeScript. OpenCode's structural signals (`$codemode`, nested
`tools.<ns>.<tool>`), TanStack, and Cloudflare take priority; PTC's own signals
outrank the generic `Object.keys(tools)` shape that OpenCode also uses. Vercel
remains the generic TypeScript fallback, so a PTC program with none of these
signals is still compiled correctly as `vercel`.

## OpenAI Codex code mode dialect (`codex-rs/code-mode-runtime`)
OpenAI Codex's `exec` tool runs raw JavaScript in a fresh V8 isolate and exposes
its tools on a global `tools` object. Its name rule,
`normalize_code_mode_identifier`, is byte-for-byte Pi's `toCodemodeIdentifier`,
and its `text`/`image`/`store`/`load`/`exit`/`ALL_TOOLS` helpers match Pi's, so
already-written tool calls need **no rewriting**:

| Codex | Pi |
|---|---|
| `exec({ code })` | `codemode({ code })` |
| `await tools.mcp__ologs__get_profile(…)` | unchanged (same identifier rule) |
| `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}` | `// @options: {"max_output_tokens": 1000}`; `yield_time_ms` is dropped with a warning (`options.ts`) |
| `audio` / `generatedImage` / `notify` / `yield_control` / `setTimeout` / `clearTimeout` | no Pi equivalent — `translate.ts` warns and leaves the call in place |

Codex's `max_output_tokens` maps to Pi's field; `yield_time_ms` is Codex's early
yield, not Pi's `timeout_ms`, so mapping it would be wrong. `generatedImage`'s
warning points at Pi's `image(block)`.

Detection signal: `codex:@exec` (from the `hadExecLine` context flag, like
Pi's `hadOptionsLine`) and `codex:<helper>` for `yield_control`, `notify`,
`generatedImage`, and `audio`. Codex is checked after OpenCode/TanStack/
Cloudflare/PTC/Vercel but before Pi's own helper signals, because a Codex script
also mentions `ALL_TOOLS`/`models`. A Codex script with none of these signals is
indistinguishable from Pi and is compiled as Pi (which is correct).

## Known limitations
- Statement-form Cloudflare programs that use only named providers (no
  `codemode.*`, no async-arrow wrapper) still detect as `unknown`, so the
  interop `dialect` is inaccurate — but the provider rewrites now run anyway:
  `translate.ts` applies the Cloudflare rule to every statement, catalog
  permitting.
- Non-erasable TypeScript: sucrase compiles `enum`/`namespace` into running
  JavaScript, where DeepSeek's erasable-only PTC reference would reject the
  program.
- Identifier collisions: `web-search` / `web_search` both map to
  `tools.web_search`. Resolution is deterministic (the written raw name wins
  via the exact map; ambiguous fuzzy keys are dropped) and emits no warning.
- Dynamic bracket access (`tools[expr]`, a non-literal property) is never
  rewritten, silently — every pass only matches string-literal properties.
- `ALL_TOOLS` entries are `{ name, description }` objects; model code that
  treats them as strings (e.g. `ALL_TOOLS.filter(n => /x/.test(n))`) is not
  normalized (observed in real sessions).

## External References
| Need | File |
|------|------|
| Domain glossary | `CONTEXT.md` |
| Interop contract | `contract.ts` |
| Pi extension docs | [pi docs](https://github.com/earendil-works/pi-coding-agent/docs) |
| Pi codemode docs | `<pi package>/docs/codemode.md` |
| Pi packages | [packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) |

## Commit Attribution
AI commits MUST include:
```
Co-Authored-By: MiMo <mimo@xiaomi.com>
```
