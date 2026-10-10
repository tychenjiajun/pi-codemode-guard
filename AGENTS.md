# Agent Instructions

## Package Manager
- Use **pnpm**: `pnpm install`

## Commands
| Task | Command |
|------|---------|
| Run all tests | `pnpm test` |
| Type check | `pnpm typecheck` |
| Run a single test file | `pnpm vitest run compile.test.ts` |

## Key Conventions
- This is a **pi extension** — entry point is `index.ts`
- Test files: `*.test.ts` alongside source files
- Keep the compiler **pure**: every pass in `compile.ts` takes a string and returns a string; no I/O, no pi state. Passes that need the tool catalog get it as a name list (`rewriteToolIdentifiers(code, tools?)`, `compileCodemodeSource(input, { tools })`), so they stay data-only
- A compile pass must be **best-effort and idempotent**: `compile(compile(x)) === compile(x)`, and an unparseable script is returned unchanged (with a warning) instead of throwing
- Use `vi`/fixtures for time-dependent or UI tests; mock `pi` and `ctx.ui` as `index.test.ts` does

## Architecture
- `index.ts` — Extension entry. Runs `createCodemodeExtension()` through a `pi` proxy that adds `prepareArguments` to the codemode tool; compiles validated `code` in the `tool_call` handler; stamps `details.piCodemodeGuard` in `tool_result`
- `arguments.ts` — Pre-validation argument normalization (`prepareArguments` shim): raw string, alias fields, nested source, JSON programs
- `compile.ts` — The compiler pipeline (fences → options → JSON program → tanstack/vercel/ptc typescript → generic strip-typescript → IIFE → opencode / cloudflare / tanstack / vercel / ptc dialect → await → identifiers) and the public `CompileOptions`/`CompileResult`
- `program.ts` — JSON tool-call programs → `await tools.<id>({...})` JavaScript
- `fences.ts` — Markdown fence stripping
- `options.ts` — `// @options:` line normalization and field-alias mapping
- `iife.ts` — Redundant async-IIFE unwrapping
- `opencode.ts` — OpenCode→Pi translation (namespace paths, `$codemode.search`, `Object.keys(tools)`); re-exports the shared dialect detection
- `cloudflare.ts` — Cloudflare agents→Pi translation (`codemode.*` namespace, `codemode.search`/`describe` shims, named providers, `sanitizeToolName` mapping)
- `tanstack.ts` — TanStack AI code mode→Pi translation (`external_<tool>` bindings → `tools.*`, via the shared catalog)
- `vercel.ts` — Vercel AI SDK code mode→Pi translation (`{ js }` envelope, TypeScript source, `tools["raw-name"]` → `tools.<identifier>`, via the shared catalog)
- `ptc.ts` — DeepSeek Harness PTC dialect→Pi translation (global `tools` with arbitrary raw names, `Object.keys(tools)` → `ALL_TOOLS`, TypeScript source, via the shared catalog)
- `typescript.ts` — TypeScript syntax stripping via sucrase (TanStack's `execute_typescript`, Vercel's `{ js }`, and DeepSeek PTC's `run_code` all accept TS, Pi's sandbox is JS)
- `dialect.ts` — `detectCodemodeDialect(code, { hadOptionsLine })` (pi/opencode/cloudflare/tanstack/vercel/ptc/unknown); the context flag restores the `@options` signal that pass 2's split removed — and the `CodemodeDialect` type
- `catalog.ts` — Shared tool-catalog resolution and AST traversal used by both dialect compilers
- `await-inject.ts` — acorn-based missing-`await` repair (the pi #10555 bug)
- `rewrite.ts` — catalog-aware `tools["a-b"]` → `tools.a_b` identifier rewriting (`rewriteToolIdentifiers(code, tools?)`)
- `identifiers.ts` — pi's `toCodemodeIdentifier` rule
- `parse.ts` — Shared acorn parsing helpers
- `contract.ts` — Versioned `details.piCodemodeGuard` interop contract
- `ui.ts` — Compile receipt + transient footer status

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
- `dialect` — `"pi"`, `"opencode"`, `"cloudflare"`, `"tanstack"`, `"vercel"`, `"ptc"`, or `"unknown"`
- `warnings` — non-fatal problems (e.g. a dropped `@options` line or an unresolved OpenCode/Vercel tool path). Dedup is per pass: `ptc.ts` and `vercel.ts` collapse repeated unresolved-name warnings (per identifier); `opencode.ts` and `cloudflare.ts` report every occurrence

Consumers must parse via `readPiCodemodeGuardDetails` and fall back to the inline
content for unknown versions. The shape is additive-only; `dialect` and unknown
fields are ignored by older readers.

## Compile passes
Passes run in this order and each may be skipped independently:

1. `strip-code-fence`
2. `normalize-options-line`
3. `compile-json-program`
4. `tanstack-typescript` — only when the dialect is `tanstack`; strips TypeScript syntax via sucrase before `unwrap-iife` can parse it
5. `vercel-typescript` — only when the dialect is `vercel`; strips TypeScript syntax via sucrase before `unwrap-iife` can parse it
6. `ptc-typescript` — only when the dialect is `ptc`; strips erasable TypeScript syntax via sucrase before `unwrap-iife` can parse it
7. `strip-typescript` — generic TypeScript fallback: only when the dialect is `unknown` and acorn cannot parse the script; best-effort sucrase strip, then the dialect is re-detected (never runs after a dialect TypeScript pass already ran)
8. `unwrap-iife`
9. `opencode-dialect(N)` — only when `detectCodemodeDialect` returns `opencode`
10. `cloudflare-dialect(N)` — only when `detectCodemodeDialect` returns `cloudflare`
11. `tanstack-dialect(N)` — only when the dialect is `tanstack`; rewrites `external_<tool>` bindings to `tools.*`
12. `vercel-dialect(N)` — only when the dialect is `vercel`; rewrites `tools["raw-name"]` bracket access to `tools.<identifier>` against the live catalog
13. `ptc-dialect(N)` — only when the dialect is `ptc`; rewrites raw tool names to `tools.<identifier>`, maps `Object.keys(tools)` to `ALL_TOOLS.map((t) => t.name)`, and warns on `ToolCallError` / `await import(...)`
14. `await-async-calls(N)` — insert missing `await` on `tools.*`/lookup helpers
15. `rewrite-tool-identifiers` — `tools["a-b"]` → `tools.a_b`; catalog-aware: with `options.tools` given, the written raw name resolves through `resolveToolPath` first, otherwise the naive `toCodemodeIdentifier` is used

A JSON program (pass 3) is compiler-generated JavaScript: it skips passes 4–13
(the dialect passes parse model-written source) and runs only `await-async-calls`
and `rewrite-tool-identifiers` on the generated script, so raw-JavaScript string
steps still get awaited and rewritten.

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
detects as `unknown` and the provider rewrites never run; and `unwrap-iife` only
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

## Known limitations
- Statement-form Cloudflare programs that use only named providers (no
  `codemode.*`, no async-arrow wrapper) detect as `unknown`: catalog-free
  detection cannot see providers, so the provider rewrites never run.
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
