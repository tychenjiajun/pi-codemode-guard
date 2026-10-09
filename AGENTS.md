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
- Keep the compiler **pure**: every pass in `compile.ts` takes a string and returns a string; no I/O, no pi state
- A compile pass must be **best-effort and idempotent**: `compile(compile(x)) === compile(x)`, and an unparseable script is returned unchanged (with a warning) instead of throwing
- Use `vi`/fixtures for time-dependent or UI tests; mock `pi` and `ctx.ui` as `index.test.ts` does

## Architecture
- `index.ts` — Extension entry. Runs `createCodemodeExtension()` through a `pi` proxy that adds `prepareArguments` to the codemode tool; compiles validated `code` in the `tool_call` handler; stamps `details.piCodemodeGuard` in `tool_result`
- `arguments.ts` — Pre-validation argument normalization (`prepareArguments` shim): raw string, alias fields, nested source, JSON programs
- `compile.ts` — The compiler pipeline (fences → options → JSON program → IIFE → opencode dialect → cloudflare dialect → tanstack types+bindings → await → identifiers) and the public `CompileOptions`/`CompileResult`
- `program.ts` — JSON tool-call programs → `await tools.<id>({...})` JavaScript
- `fences.ts` — Markdown fence stripping
- `options.ts` — `// @options:` line normalization and field-alias mapping
- `iife.ts` — Redundant async-IIFE unwrapping
- `opencode.ts` — OpenCode→Pi translation (namespace paths, `$codemode.search`, `Object.keys(tools)`); re-exports the shared dialect detection
- `cloudflare.ts` — Cloudflare agents→Pi translation (`codemode.*` namespace, `codemode.search`/`describe` shims, named providers, `sanitizeToolName` mapping)
- `tanstack.ts` — TanStack AI code mode→Pi translation (`external_<tool>` bindings → `tools.*`, via the shared catalog)
- `typescript.ts` — TypeScript syntax stripping via sucrase (TanStack's `execute_typescript` accepts TS, Pi's sandbox is JS)
- `dialect.ts` — `detectCodemodeDialect` (pi/opencode/cloudflare/tanstack/unknown) and the `CodemodeDialect` type
- `catalog.ts` — Shared tool-catalog resolution and AST traversal used by both dialect compilers
- `await-inject.ts` — acorn-based missing-`await` repair (the pi #10555 bug)
- `rewrite.ts` — `tools["a-b"]` → `tools.a_b` identifier rewriting
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
- `dialect` — `"pi"`, `"opencode"`, `"cloudflare"`, `"tanstack"`, or `"unknown"`
- `warnings` — non-fatal problems (e.g. a dropped `@options` line or an unresolved OpenCode tool path)

Consumers must parse via `readPiCodemodeGuardDetails` and fall back to the inline
content for unknown versions. The shape is additive-only; `dialect` and unknown
fields are ignored by older readers.

## Compile passes
Passes run in this order and each may be skipped independently:

1. `strip-code-fence`
2. `normalize-options-line`
3. `compile-json-program`
4. `unwrap-iife`
5. `opencode-dialect(N)` — only when `detectCodemodeDialect` returns `opencode`
6. `cloudflare-dialect(N)` — only when `detectCodemodeDialect` returns `cloudflare`
7. `tanstack-typescript` — only when the dialect is `tanstack`; strips TypeScript syntax via sucrase before the acorn passes can parse it
8. `tanstack-dialect(N)` — only when the dialect is `tanstack`; rewrites `external_<tool>` bindings to `tools.*`
9. `await-async-calls(N)` — insert missing `await` on `tools.*`/lookup helpers
10. `rewrite-tool-identifiers` — `tools["a-b"]` → `tools.a_b`

## OpenCode dialect
The `tools.<ns>.<tool>` → `tools.<identifier>` mapping needs Pi's live catalog,
so `compileCodemodeSource(input, { tools: pi.getAllTools().map((t) => t.name) })`
must be given it. Resolution order: exact separators (`.`, `__`, `_`, `/`, `-`),
then a fuzzy `normalizeToolKey` match, then a deterministic flatten with a
warning. `tools.$codemode.search(...)` becomes an inline `searchTools(...)` shim
echoing OpenCode's `{ items, remaining, next }` shape. Keep the compiler pure:
catalog names come in as data, not from pi inside the module.

## Cloudflare dialect
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

## TanStack AI code mode dialect
`@tanstack/ai-code-mode` takes `{ typescriptCode }` (accepted as an `arguments.ts`
alias) and runs each tool as a global `external_<tool>` async function in a TS
sandbox. `compileTanstackDialect` rewrites `external_<tool>(...)` →
`tools.<identifier>` against the live catalog (the same `resolveToolPath` used by
OpenCode). The source is TypeScript, so `stripTypeScriptSyntax` (`typescript.ts`,
via sucrase) runs first — before `unwrap-iife`, so a wrapped TS program still
unwraps. `external_*` identifiers the script itself declares are left untouched.

## External References
| Need | File |
|------|------|
| Domain glossary | `CONTEXT.md` |
| Interop contract | `contract.ts` |
| Pi extension docs | [pi docs](https://github.com/earendil-works/pi-coding-agent/docs) |
| Pi codemode docs | `<pi package>/docs/codemode.md` |

## Commit Attribution
AI commits MUST include:
```
Co-Authored-By: MiMo <mimo@xiaomi.com>
```
