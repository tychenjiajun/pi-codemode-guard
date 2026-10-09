# pi-codemode-guard

A [pi](https://github.com/earendil-works/pi) extension that **compiles the tool
calls models write for `codemode` into the JavaScript pi's sandbox expects**.

Many models cannot write pi's codemode tool call correctly. They wrap the script
in a markdown fence, send it as JSON tool calls, use the wrong field name, write
a relaxed `@options:` line, wrap everything in an async IIFE, or forget the
`await` — and an unawaited tool call is silently JSON-serialized as `{}`.

`pi-codemode-guard` fixes all of that before the script reaches the sandbox,
without forking the codemode implementation.

```
model                      pi-codemode-guard                    codemode sandbox
───────────────────────────────────────────────────────────────────────────────
{ script: "```js … ```" }  →  { code: "…" } (aliases)          →  runs the
[a1, a2] JSON tool calls   →  await tools.*() (compiler)           intended
const x = searchTools(...) →  const x = await searchTools(...)      script
```

## Why

Real failures from pi sessions and the pi tracker:

- **Missing `await` on async helpers.** `const hits = searchTools("feishu")`
  printed `feishu: {}` because the pending promise was serialized. Pi fixed the
  *description* for this (`await searchTools(...)`, commit `269121616`, issue
  #10555); the guard fixes the *scripts*.
- **JSON tool-call programs.** Models that cannot write JavaScript emit
  `[{"tool":"read","args":{"path":"package.json"}}]`, which pi validates as a
  string only if it is wrapped, and then fails to run.
- **Markdown fences.** The pi docs explicitly say "raw JavaScript source, not
  JSON and not a markdown code fence"; models ignore that.

## What it does

Two hooks, installed automatically:

1. **Argument normalization** (`prepareArguments`). Pi validates tool arguments
   *before* any execution hook, so the guard adds a shim to the codemode tool
   definition. It accepts a raw string, the common field aliases (`script`,
   `source`, `javascript`, `input`, …), nested source objects
   (`{ code: { language, content } }`), a single JSON tool call, and JSON
   tool-call programs.
2. **Script compilation** (the `tool_call` event). The validated `code` is
   compiled in place by `compile.ts`.

### Compile passes

| Pass | Before | After |
|------|--------|-------|
| `strip-code-fence` | ` ```js\nconst x = 1;\n``` ` | `const x = 1;` |
| `normalize-options-line` | `/* @options: {'maxOutputTokens': 2000} */` | `// @options: {"max_output_tokens": 2000}` |
| `compile-json-program` | `[{"tool":"read","args":{"path":"a"}}]` | `const _result0 = await tools.read({"path":"a"});\nreturn _result0;` |
| `unwrap-iife` | `(async () => { … })();` | `…` |
| `opencode-dialect` | `await tools.orders.lookup({…})` | `await tools.orders_lookup({…})` |
| `await-async-calls` | `const hits = searchTools("x");` | `const hits = await searchTools("x");` |
| `rewrite-tool-identifiers` | `tools["mcp__dev-radius__search"](…)` | `tools.mcp__dev_radius__search(…)` |

Every pass is independent, idempotent, and best-effort. A script that does not
parse is returned unchanged with a warning, so a guard bug can never block a
tool call.

## Dialects

The compiler detects which codemode dialect a script is written in and, for the
OpenCode dialect, translates it to Pi.

`detectCodemodeDialect(code)` returns `pi`, `opencode`, or `unknown` with the
signals it found. OpenCode-exclusive signals are `$codemode`, a `tools.<ns>.<tool>`
path (Pi tools are always single-level), and `Object.keys(tools)`.

When the dialect is `opencode`, `compileOpencodeDialect` runs before the await
pass:

| OpenCode (`@opencode-ai/codemode`) | Pi codemode |
|---|---|
| `tools.orders.lookup({…})` | `tools.orders_lookup({…})` — resolved against the live catalog |
| `tools.context7["resolve-library-id"]({…})` | `tools.context7_resolve_library_id({…})` |
| `tools.mcp.dev.radius.search({…})` | `tools.mcp__dev_radius__search({…})` (fuzzy name match) |
| `await tools.$codemode.search({ query, namespace, limit, offset })` | an `await searchTools(...)` shim returning `{ items: [{ path, description, signature }], remaining, next }` |
| `Object.keys(tools)` | `ALL_TOOLS.map((t) => t.name)` |
| `return value`, `console.log`, `Promise.all`, top-level `await` | already valid Pi — left untouched |

Tool-path resolution needs Pi's live catalog, so the extension passes
`pi.getAllTools().map((t) => t.name)` into the compiler. Exact separators
(`.`, `__`, `_`, `/`, `-`) are tried first, then a fuzzy match that normalizes
both sides (`mcp.dev.radius.search` ↔ `mcp__dev-radius__search`). A path with no
catalog match is flattened deterministically and reported in `warnings`.

`console.log` maps to Pi's `<console_output>` block and OpenCode's `{ ok, value }`
envelope is dropped (Pi surfaces the `return` value directly); both are
compatible in the OpenCode → Pi direction, so no rewrite is needed.

### What it deliberately leaves alone

- `ALL_TOOLS` used as if it were an array of strings (ambiguous semantics).
- Missing `await` inside a **non-async** function (inserting one is a syntax
  error).
- Members of `Promise.all` / `allSettled` / `race` / `any` and promises chained
  with `.then` / `.catch` / `.finally`.
- Envelope shapes that already failed pi validation before the arguments hook.

## Install

The extension is a pi package:

```bash
pi install /path/to/pi-codemode-guard
# or run it directly:
pi -e /path/to/pi-codemode-guard/index.ts
```

It registers the `codemode` tool itself, so it works both with the CLI's
built-in codemode extension (which it replaces) and in SDK sessions that add
`createCodemodeExtension()`.

## How it stays compatible

The built-in `codemode` tool is registered by a **replaceable** inline
extension, and reimplementing it would lose `models`, `store()` persistence, and
`codemode.mode`. Instead the guard runs the canonical
`createCodemodeExtension()` factory through a small `pi` proxy whose
`registerTool` adds the argument shim and a compile receipt. The tool keeps
`parameters === codemodeSchema` (so `isCodemodeTool` still recognizes it) and
all of its original options.

## Interop contract

Compiled calls publish `details.piCodemodeGuard` (see `contract.ts`):

```ts
interface PiCodemodeGuardDetails {
  version: 1;
  originalCode: string; // what pi validated
  compiledCode: string; // what the sandbox received
  passes: string[];     // e.g. ["opencode-dialect(2)", "await-async-calls(2)"]
  parsed: boolean;
  dialect: "pi" | "opencode" | "unknown";
  warnings: string[];
}
```

Read it with `readPiCodemodeGuardDetails(details)`. The shape is versioned and
additive-only; consumers must fall back to the inline content for versions they
do not understand.

## Development

```bash
pnpm install
pnpm test        # 103 unit tests
pnpm typecheck
```

Layout and design notes live in [`AGENTS.md`](./AGENTS.md) and
[`CONTEXT.md`](./CONTEXT.md).

## License

MIT
