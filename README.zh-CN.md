# pi-codemode-guard

[English](./README.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![pi extension](https://img.shields.io/badge/pi-extension-7c3aed.svg)](https://github.com/earendil-works/pi)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](./tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-103%20passing-brightgreen.svg)](./package.json)
[![pnpm](https://img.shields.io/badge/package%20manager-pnpm-f69220.svg)](https://pnpm.io)

**pi-codemode-guard** 是一个开源（MIT 协议）、TypeScript 编写的
[pi](https://github.com/earendil-works/pi) AI 编程智能体扩展，用于**在脚本进入沙箱之前
修复 LLM 编写的 `codemode` 脚本**。它会补上缺失的 `await`、剥掉 markdown 代码围栏、把
JSON 工具调用程序转换成真正的 JavaScript、规范化 `@options:` 行、拆掉多余的 async IIFE，
并翻译 OpenCode 方言 —— 让 AI 生成的智能体脚本真正跑起来，而不是静默失败。

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
| `unwrap-iife` | `(async () => { … })();` | `…` |
| `opencode-dialect` | `await tools.orders.lookup({…})` | `await tools.orders_lookup({…})` |
| `await-async-calls` | `const hits = searchTools("x");` | `const hits = await searchTools("x");` |
| `rewrite-tool-identifiers` | `tools["mcp__dev-radius__search"](…)` | `tools.mcp__dev_radius__search(…)` |

每个 pass 都是独立、幂等、尽力而为的。无法解析的脚本会原样返回并附带一条警告，
所以本扩展的 bug 永远不会阻断一次工具调用。

## 方言

编译器会检测脚本使用的是哪种 codemode 方言，并在 OpenCode 方言时将其翻译为 Pi。

`detectCodemodeDialect(code)` 返回 `pi`、`opencode` 或 `unknown`，并附带命中的信号。
OpenCode 独有信号包括 `$codemode`、`tools.<ns>.<tool>` 路径（Pi 的工具永远是单层的），
以及 `Object.keys(tools)`。

当方言为 `opencode` 时，`compileOpencodeDialect` 会在 await pass 之前运行：

| OpenCode (`@opencode-ai/codemode`) | Pi codemode |
|---|---|
| `tools.orders.lookup({…})` | `tools.orders_lookup({…})` —— 对照实时工具目录解析 |
| `tools.context7["resolve-library-id"]({…})` | `tools.context7_resolve_library_id({…})` |
| `tools.mcp.dev.radius.search({…})` | `tools.mcp__dev_radius__search({…})`（模糊名称匹配） |
| `await tools.$codemode.search({ query, namespace, limit, offset })` | 一个 `await searchTools(...)` 垫片，返回 `{ items: [{ path, description, signature }], remaining, next }` |
| `Object.keys(tools)` | `ALL_TOOLS.map((t) => t.name)` |
| `return value`、`console.log`、`Promise.all`、顶层 `await` | 本身就是合法 Pi —— 原样保留 |

工具路径解析需要 Pi 的实时目录，因此扩展会把
`pi.getAllTools().map((t) => t.name)` 传入编译器。先尝试精确分隔符
（`.`、`__`、`_`、`/`、`-`），再做归一化后的模糊匹配
（`mcp.dev.radius.search` ↔ `mcp__dev_radius__search`）。目录中匹配不到的路径会被
确定性地展平，并记录到 `warnings` 中。

`console.log` 映射为 Pi 的 `<console_output>` 块；OpenCode 的 `{ ok, value}` 信封被
丢弃（Pi 直接展示 `return` 的值）。这两者在 OpenCode → Pi 方向上都是兼容的，
因此无需改写。

### 它刻意不动的东西

- 被当作字符串数组使用的 `ALL_TOOLS`（语义有歧义）。
- **非 async 函数**内部缺失的 `await`（插入它会变成语法错误）。
- `Promise.all` / `allSettled` / `race` / `any` 的成员，以及用
  `.then` / `.catch` / `.finally` 链起来的 promise。
- 在参数钩子之前就已没通过 pi 校验的信封结构。

## 安装

本扩展是一个 pi 包：

```bash
# 直接从 GitHub 安装（推荐）
pi install git:github.com/tychenjiajun/pi-codemode-guard

# 或从本地检出安装
pi install /path/to/pi-codemode-guard

# 或不安装直接运行
pi -e /path/to/pi-codemode-guard/index.ts
```

它自己注册 `codemode` 工具，因此既适用于 CLI 内置的 codemode 扩展（会被它替换），
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
  dialect: "pi" | "opencode" | "unknown";
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
异步辅助函数缺失的 `await`、`tools["a-b"](...)` 索引写法，以及 OpenCode 方言的
工具路径 —— 每一项都是独立、幂等的编译 pass。

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
pnpm test        # 103 个单元测试
pnpm typecheck
```

代码结构和设计说明见 [`AGENTS.md`](./AGENTS.md) 与 [`CONTEXT.md`](./CONTEXT.md)。

## 许可证

MIT
