# pi-codemode-guard

[English](./README.md) | 简体中文

<p align="center">
  <img src="./assets/preview.svg" alt="pi-codemode-guard 在脚本进入 QuickJS 沙箱之前编译 LLM 写的 codemode 脚本" width="880">
</p>

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![pi extension](https://img.shields.io/badge/pi-extension-7c3aed.svg)](https://github.com/earendil-works/pi)
[![pi package](https://img.shields.io/badge/pi-package-7c3aed.svg)](https://pi.dev/packages)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](./tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-318%20passing-brightgreen.svg)](./package.json)
[![pnpm](https://img.shields.io/badge/package%20manager-pnpm-f69220.svg)](https://pnpm.io)

**pi-codemode-guard** 是一个开源（MIT 协议）、TypeScript 编写的
[pi](https://github.com/earendil-works/pi) AI 编程智能体扩展，用于**在脚本进入沙箱之前
修复 LLM 编写的 `codemode` 脚本**。它会补上缺失的 `await`、剥掉 markdown 代码围栏、把
JSON 工具调用程序转换成真正的 JavaScript、规范化 `@options:` 行、拆掉多余的 async IIFE，
并翻译 OpenCode、Cloudflare agents、TanStack AI、Vercel AI SDK 与 DeepSeek Harness PTC code mode 方言 —— 让 AI 生成的智能体脚本真正跑起来，而不是静默失败。

一句话概括：*一个尽力而为、幂等的编译器，把任意 LLM 写坏的 codemode 工具调用转换成
pi 的 QuickJS 沙箱所期望的确切 JavaScript —— 且完全不 fork codemode 的实现。*

很多模型写不对 pi 的 codemode 工具调用：它们把脚本包在 markdown 围栏里、用 JSON 工具
调用的形式发送、用错字段名、写成宽松的 `@options:` 行、把一切包进 async IIFE、或者忘记
`await` —— 而未 await 的工具调用会被静默地 JSON 序列化成 `{}`。

`pi-codemode-guard` 在脚本到达沙箱之前修复以上所有问题，同样不 fork codemode 的实现。

```
模型                       pi-codemode-guard                    codemode 沙箱
───────────────────────────────────────────────────────────────────────────────
{ script: "```js … ```" }  →  { code: "…" } (字段别名)           →  执行目标
[a1, a2] JSON 工具调用     →  await tools.*() (编译)                脚本
const x = searchTools(...) →  const x = await searchTools(...)
```

## 为什么需要它

来自真实 pi 会话和 pi 问题追踪器的故障：

- **异步辅助函数缺少 `await`。** `const hits = searchTools("feishu")` 打印出
  `feishu: {}`，因为待定的 promise 被序列化了。Pi 修复了*文档描述*
  （`await searchTools(...)`，commit `269121616`，issue #10555）；
  而本扩展修复的是*脚本本身*。
- **JSON 工具调用程序。** 写不出 JavaScript 的模型会输出
  `[{"tool":"read","args":{"path":"package.json"}}]`，pi 只有在它被正确包装时才
  能通过字符串校验，之后仍然无法运行。
- **markdown 围栏。** pi 文档明确写着"原始 JavaScript 源码，不是 JSON，也不是
  markdown 代码围栏"；模型照样忽略。

## 它做了什么

自动安装两个钩子：

1. **参数规范化**（`prepareArguments`）。pi 在任何执行钩子*之前*就校验工具参数，
   因此本扩展会向 codemode 工具定义注入一个垫片。它接受裸字符串、常见字段别名
   （`script`、`source`、`javascript`、`input`、…）、嵌套的源码对象
   （`{ code: { language, content } }`）、单条 JSON 工具调用，以及 JSON 工具调用程序。
2. **脚本编译**（`tool_call` 事件）。通过校验的 `code` 就地由 `compile.ts` 编译。

### 编译 Pass

| Pass | 之前 | 之后 |
|------|------|------|
| `strip-code-fence` | ` ```js\nconst x = 1;\n``` ` | `const x = 1;` |
| `normalize-options-line` | `/* @options: {'maxOutputTokens': 2000} */` | `// @options: {"max_output_tokens": 2000}` |
| `compile-json-program` | `[{"tool":"read","args":{"path":"a"}}]` | `const _result0 = await tools.read({"path":"a"});\nreturn _result0;` |
| `tanstack-typescript` | `const city: string = "London";` | `const city = "London";` |
| `vercel-typescript` | `const c: string = "London";` | `const c = "London";` |
| `ptc-typescript` | `let total: number = 0;` | `let total = 0;` |
| `strip-typescript` | `const n: number = 1;`（没有方言认领它） | `const n = 1;` |
| `unwrap-iife` | `(async () => { … })();` | `…` |
| `opencode-dialect` | `await tools.orders.lookup({…})` | `await tools.orders_lookup({…})` |
| `cloudflare-dialect` | `await codemode.lookupOrder({…})` | `await tools.lookupOrder({…})` |
| `tanstack-dialect` | `external_getWeather({…})` | `tools.getWeather({…})` |
| `vercel-dialect` | `await tools["web-search"]({ q })` | `await tools.web_search({ q })` |
| `ptc-dialect` | `await tools["my-tool"]({ q })` | `await tools.my_tool({ q })` |
| `await-async-calls` | `const hits = searchTools("x");` | `const hits = await searchTools("x");` |
| `rewrite-tool-identifiers` | `tools["mcp__dev-radius__search"](…)` | `tools.mcp__dev_radius__search(…)` |

每个 pass 都是独立、幂等、尽力而为的。无法解析的脚本会原样返回并附带一条警告，
所以本扩展的 bug 永远不会阻断一次工具调用。JSON 工具调用程序是编译器生成的
JavaScript：它会跳过各方言 pass，只在结果上运行 `await-async-calls` 和
`rewrite-tool-identifiers`。

## 方言

编译器会检测脚本使用的是哪种 codemode 方言，并将其翻译为 Pi。

`detectCodemodeDialect(code, { hadOptionsLine })` 返回 `pi`、`opencode`、`cloudflare`、
`tanstack`、`vercel`、`ptc` 或 `unknown`，并附带命中的信号；第二个参数恢复了
options pass 移除的 `@options` 信号。
OpenCode 独有信号包括 `$codemode`、`tools.<ns>.<tool>` 路径（Pi 的工具永远是单层的），
以及 `Object.keys(tools)`。Cloudflare 信号包括 `codemode.<tool>` / `codemode.search`
平台调用，以及裸的 `async () => { … }` 程序包装。TanStack 信号是裸的
`external_<tool>` 绑定引用（绝不会是 `tools.external_<tool>` 成员访问）。
Vercel 信号（`vercel:tools.<name>`）是 TypeScript 源码（acorn 无法解析）且引用了
`tools`，同时不带任何 OpenCode/TanStack/Cloudflare 信号 —— TanStack（`external_`）
与 OpenCode（`$codemode` / 嵌套 `tools.<ns>.<tool>`）优先。DeepSeek Harness PTC
信号是 `ptc:ToolCallError` 与 `ptc:import()`，以及仅当 acorn 无法解析
TypeScript 时的 `ptc:Object.keys(tools)`；OpenCode 的结构性信号
（`$codemode` / 嵌套 `tools.<ns>.<tool>`）、TanStack 与 Cloudflare 优先，但 PTC
自身信号优先于 OpenCode 也使用的通用 `Object.keys(tools)` 形态；Vercel 仍是通用的
TypeScript 回退，因此不带任何这些信号的 PTC 程序仍会正确地按 `vercel` 编译。

当方言为 `opencode` 时，`compileOpencodeDialect` 会在 await pass 之前运行：

| OpenCode (`@opencode-ai/codemode`) | Pi codemode |
|---|---|
| `tools.orders.lookup({…})` | `tools.orders_lookup({…})` —— 对照实时工具目录解析 |
| `tools.context7["resolve-library-id"]({…})` | `tools.context7_resolve_library_id({…})` |
| `tools.mcp.dev.radius.search({…})` | `tools.mcp__dev_radius__search({…})`（模糊名称匹配） |
| `await tools.$codemode.search({ query, namespace, limit, offset })` | 一个 `await searchTools(...)` 垫片，返回 `{ items: [{ path, description, signature }], remaining, next }` |
| `Object.keys(tools)` | `ALL_TOOLS.map((t) => t.name)` |
| `Object.keys(tools.<ns>)` | 同一份 `ALL_TOOLS` 名称列表，按命名空间前缀过滤（普通与 `mcp__` 两种拼写） |
| `for...in tools.<ns>` | 不改写 —— 发出警告并指向 `ALL_TOOLS.map((t) => t.name)` |
| `return value`、`console.log`、`Promise.all`、顶层 `await` | 本身就是合法 Pi —— 原样保留 |

工具路径解析需要 Pi 的实时目录，因此扩展会把
`pi.getAllTools().map((t) => t.name)` 传入编译器。先尝试精确分隔符
（`.`、`__`、`_`、`/`、`-`，每种还会再试 MCP 的 `mcp__` 前缀），再做归一化后的模糊匹配
（`mcp.dev.radius.search` ↔ `mcp__dev_radius__search`）。目录中匹配不到的路径会被
确定性地展平，并记录到 `warnings` 中。

`console.log` 映射为 Pi 的 `<console_output>` 块；OpenCode 的 `{ ok, value}` 信封被
丢弃（Pi 直接展示 `return` 的值）。这两者在 OpenCode → Pi 方向上都是兼容的，
因此无需改写。

当方言为 `cloudflare` 时，会翻译
[`@cloudflare/codemode`](https://github.com/cloudflare/agents/tree/main/packages/codemode)
程序。`unwrap-iife` 先移除 `async () => { … }` 包装，然后
`compileCloudflareDialect` 改写命名空间：

| Cloudflare agents | Pi codemode |
|---|---|
| `codemode.lookupOrder({…})` | `tools.lookupOrder({…})` —— 去掉默认命名空间 |
| `state.readFile("/path")` | `tools.state_readFile("/path")` —— 具名 provider，仅在实时目录命中时改写 |
| `await codemode.search("query")` | 一个 `await searchTools(...)` 垫片，返回 Cloudflare 的 `{ results: [{ path, connector, method, description, kind }], total, truncated }` |
| `await codemode.describe(path)` | 一个 `await describeTool(...)` 垫片，返回 `{ path, description, types }` |
| `codemode.run(name)` / `codemode.step(name, fn)` | Pi 无对应能力 —— 原样保留并给出警告 |
| `Math`/`JSON`/`console`/`Promise`/`Object`/`searchTools` 等 | 永远不会被当作 provider 命名空间 |

Cloudflare 的工具命名规则（`sanitizeToolName`）与 Pi 的 `toCodemodeIdentifier`
不同：它剥离非法字符而不是替换、给数字开头加 `_`（`3d-render` → `_3d_render`）、
给保留字加 `_` 后缀（`delete` → `delete_`）。因此目录同时以两种拼写建索引，
`codemode.delete_()` 能映射回 `tools.delete()`，`codemode._3d_render()` 映射到
`tools._d_render()`。脚本自身绑定的名字（`const state = { … }`）与无法解析的
provider 不会被改动（后者在提供了目录时会给出警告）；位置参数的 provider
调用（`state.readFile("/path")`）原样保留，因为编译器无从得知 Pi 的参数名。
两个已知限制：只使用具名 provider 的语句式程序（没有 `codemode.*` 调用、没有
async-arrow 包装）会被检测为 `unknown`（检测不看目录），于是 provider 改写永远不会
运行；`export default async () => {}` 也会原样保留 —— `unwrap-iife` 只解包单独的
表达式语句。

当方言为 `tanstack` 时，会翻译 [`@tanstack/ai-code-mode`](https://github.com/TanStack/ai/tree/main/packages/ai-code-mode)
程序。源码是 TypeScript，因此 `tanstack-typescript` 先运行（`unwrap-iife` 在其后运行，
以防模型把代码包了一层），随后 `compileTanstackDialect` 改写绑定：

| TanStack AI code mode | Pi codemode |
|---|---|
| `{ typescriptCode: "…" }` | `{ code: "…" }`（经 `typescriptCode` 参数别名） |
| `external_getWeather({…})` | `tools.getWeather({…})` —— 对照实时工具目录解析 |
| 带 `my-tool` 工具的 `external_my_tool({…})` | `tools.my_tool({…})`（Pi 的 `toCodemodeIdentifier` 规则） |
| `return value`、`console.log`、`Promise.all`、顶层 `await` | 本身就是合法 Pi —— 原样保留 |

绑定前缀被剥离后，其余部分通过 Pi 的目录解析，方式与 OpenCode 命名空间路径完全相同；
无法解析的绑定会被确定性地展平（与 OpenCode 一致，并给出警告），至少保证它能解析通过。

当方言为 `vercel` 时，会翻译 [`@ai-sdk/code-mode`](https://github.com/vercel/ai/tree/main/packages/code-mode)
程序。信封字段是 `{ js: "…" }` 而非 Pi 的 `{ code }`（`js` 已被接受为参数别名），
程序作为 async 函数体运行（顶层 `await`/`return` 有效）。源码是 TypeScript，
因此 `vercel-typescript` 在 `unwrap-iife` 之前运行，随后 `compileVercelDialect`
改写方括号访问：

| Vercel AI code mode | Pi codemode |
|---|---|
| `{ js: "…" }` | `{ code: "…" }`（经 `js` 参数别名） |
| `await tools["web-search"]({ q })` | `await tools.web_search({ q })` —— 对照实时工具目录解析 |
| `const c: string = "London";` | `const c = "London";` —— 通过 sucrase 剥离 TypeScript |
| `tools.getWeather({ location })` | `tools.getWeather({ location })`（原样保留） |

在 Vercel 中，不是合法 JS 标识符的原始工具名会保留方括号访问；
`compileVercelDialect` 对照实时目录把它们映射为 Pi 标识符，无法解析的名字会被
确定性展平（并给出警告）—— 与 OpenCode 相同的回退策略。纯 JavaScript 的 Vercel
程序可以被解析，因此 `vercel-dialect` 不会运行：其中的特殊方括号访问仍由
`rewrite-tool-identifiers` 对照目录解析，但不会给出无法解析的警告。该方言没有
`searchTools` / `ALL_TOOLS` / `codemode.*` 辅助能力；工具发现内嵌在工具描述中，
因此不需要任何垫片。

当方言为 `ptc` 时，会翻译
[`@deepseek-ai/dsh-ptc-runtime-node`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/ptc-runtime/ptc-runtime-node)
程序。DeepSeek 的 PTC 模式工具是 `run_code({ description, code })` —— 参数垫片只读
`code`（或其别名字段），因此多余的 `description` 被忽略，留下 Pi 的 `{ code }` ——
而 `code` 是一个
async TypeScript 函数体（仅限可擦除的 TypeScript），因此顶层 `await`/`return`
有效。源码是 TypeScript，因此 `ptc-typescript` 在 `unwrap-iife` 之前运行，
随后 `compilePtcDialect` 改写调用：

| DeepSeek PTC | Pi codemode |
|---|---|
| `{ code, description }` | `{ code }`（忽略 `description`） |
| `await tools["web-search"]({ q })` | `await tools.web_search({ q })` —— 对照实时工具目录解析 |
| `Object.keys(tools)` | `ALL_TOOLS.map((t) => t.name)` |
| `const c: string = "London";` | `const c = "London";` —— 通过 sucrase 剥离 TypeScript |
| `ToolCallError` | 无对应能力 —— 会发出警告 |
| `await import("node:fs")` | Pi 中不可用 —— 会发出警告 |

宿主函数暴露在一个全局 `tools` 对象上，函数名是任意字符串（模型写
`await tools.name(args)`，怪异名字用方括号访问 `tools["my-tool"](args)`）；
`compilePtcDialect` 对照实时目录把它们映射为 Pi 的 `tools.<identifier>`。
`ToolCallError`（PTC 失败工具调用的拒绝值，带 `.toolName`）与
`await import(...)`（PTC 访问 Node API 的方式）在 Pi 中没有对应能力 ——
Pi 失败的工具调用以普通 `Error` 拒绝，QuickJS 沙箱没有 `import`、`fetch`
或 Node API —— 因此两者都会发出警告。只有这两项会警告：`fetch`、`process` 与
`require` 不会被检测（它们在沙箱中不可用，只会在运行时失败）。`console.log(...)` 与 `return` 是
PTC 的输出通道，与 Pi 兼容。

### 它刻意不动的东西

- **非 async 函数**内部缺失的 `await`（插入它会变成语法错误）。
- `Promise.all` / `allSettled` / `race` / `any` 的成员，以及用
  `.then` / `.catch` / `.finally` 链起来的 promise。
- 在参数钩子之前就已没通过 pi 校验的信封结构。

### 已知限制

- 只使用具名 provider 的语句式 Cloudflare 程序（没有 `codemode.*` 调用、没有
  async-arrow 包装）会被检测为 `unknown` —— 检测不看目录 —— 因此 provider
  改写永远不会运行。
- 不可擦除的 TypeScript：sucrase 会把 `enum`/`namespace` 编译成可运行的
  JavaScript，而 DeepSeek 只接受可擦除 TypeScript 的 PTC 参考实现会拒绝它们。
- 标识符冲突（`web-search` / `web_search`）：解析是确定性的（以写下的原始名字
  为准）且不发警告，但两者都映射到同一个 `tools.web_search`。
- 动态方括号访问（`tools[expr]`，非常量属性）永远不会被改写，且静默无提示。
- `ALL_TOOLS` 的元素是 `{ name, description }` 对象；把它们当字符串用的模型代码
  （例如 `ALL_TOOLS.filter(n => /x/.test(n))`）不会被规范化（真实会话中观察到）。

## 安装

`pi-codemode-guard` 是一个 [Pi 包](https://pi.dev/packages)（带 `pi-package` 关键字，
因此有资格进入包展示廊）。用 `pi` CLI 安装，它会自行注册 `codemode` 工具：

```bash
# 从 git 安装（推荐；尚未发布到 npm）
pi install git:github.com/tychenjiajun/pi-codemode-guard

# 从本地检出安装
pi install /path/to/pi-codemode-guard

# 仅本次会话试用，不写入设置
pi -e /path/to/pi-codemode-guard
```

`pi list` 确认它已加载；`pi remove <source>` 卸载它；`pi config` 启用或禁用单个资源。
个人级安装写入 `~/.pi/agent/settings.json` —— 加 `--local`（或 `-l`）则改为把项目级
声明写入 `.pi/settings.json`（仅在项目信任通过后才会加载）。

它既适用于 CLI 内置的 codemode 扩展（会被它替换），
也适用于自行添加 `createCodemodeExtension()` 的 SDK 会话。

## 如何保持兼容

内置的 `codemode` 工具由一个**可替换的**内联扩展注册，重新实现它会丢失 `models`、
`store()` 持久化和 `codemode.mode`。本扩展的做法是让规范的
`createCodemodeExtension()` 工厂通过一个小型 `pi` 代理运行，由其 `registerTool`
追加参数垫片和编译回执。工具仍然保持 `parameters === codemodeSchema`
（因此 `isCodemodeTool` 仍能识别它），并保留其全部原始选项。

## 互操作契约

编译后的调用会发布 `details.piCodemodeGuard`（见 `contract.ts`）：

```ts
interface PiCodemodeGuardDetails {
  version: 1;
  originalCode: string; // pi 校验过的源码
  compiledCode: string; // 沙箱收到的源码
  passes: string[];     // 例如 ["opencode-dialect(2)", "await-async-calls(2)"]
  parsed: boolean;
  dialect: "pi" | "opencode" | "cloudflare" | "tanstack" | "vercel" | "ptc" | "unknown";
  warnings: string[];
}
```

用 `readPiCodemodeGuardDetails(details)` 读取。该结构带版本号且只做增量扩展；
消费方对不认识的版本必须回退到内联内容。

## 常见问题

### pi 里的 codemode 是什么？

`codemode` 是 pi 的一个工具，让模型用一段 JavaScript 脚本一次性调用 pi 的其他工具。
脚本作为 async 函数体运行在 QuickJS 沙箱中（没有 Node、文件系统、网络和定时器）；
只有它的输出会返回给模型。正确的输入恰好是 `{ code: <原始 JavaScript> }`。

### 为什么我的 codemode 调用返回空的 `{}`？

因为脚本里有未 await 的 promise（通常是 `searchTools(...)` 或 `models.*` 调用）。
待定的 promise 被 JSON 序列化成 `{}`，工具于是静默地什么也没返回。
`await-async-calls` pass 会自动补上缺失的 `await`。

### pi-codemode-guard 修复哪些模型错误？

markdown 代码围栏、JSON 工具调用程序、字段名别名（`script`、`source`、
`javascript`、…）、宽松的 `/* @options: … */` 行、多余的 async IIFE 包装、
方言之外的零散 TypeScript 注解、异步辅助函数缺失的 `await`、`tools["a-b"](...)` 索引写法，以及 OpenCode / Cloudflare
/ TanStack AI / Vercel AI SDK / DeepSeek Harness PTC code mode 方言的工具路径与命名空间 —— 每一项都是独立、幂等的编译 pass。

### 本扩展的 bug 会弄坏我的脚本吗？

不会。每个 pass 都尽力而为：无法解析的脚本会原样返回并附带警告，而不是抛错，
并且每个 pass 都可以独立跳过。测试套件保证
`compile(compile(x)) === compile(x)`。

### 它会替换 pi 内置的 codemode 工具吗？

它通过一个小代理重新注册规范的 `createCodemodeExtension()` 工厂，保留原始 schema、
`models`、`store()` 持久化和 `codemode.mode` —— 因此它是与内置工具共存，
而不是 fork 内置工具。

## 开发

```bash
pnpm install
pnpm test        # 318 个单元测试
pnpm typecheck
```

代码结构和设计说明见 [`AGENTS.md`](./AGENTS.md) 与 [`CONTEXT.md`](./CONTEXT.md)。

## 许可证

MIT
