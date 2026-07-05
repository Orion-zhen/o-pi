你现在在 `o-pi` 仓库中工作。目标是新增一个 `/stats` 命令，用只读 TUI 浮层展示当前会话统计量。这个功能要符合本仓库现有设计哲学：极简、可维护、token efficient、只使用 Pi 公开 API，不 monkey patch、不替换主 TUI、不写入会话历史。

请先阅读这些文件，理解现有风格和 API 用法：

* `agent/extensions/tui.ts`
* `src/tui/footer.ts`
* `src/tui/types.ts`
* `src/tui/text.ts`
* `agent/extensions/system-prompt.ts`
* `agent/extensions/cmd-slash-tools.ts`
* `docs/tui.md`
* `docs/slash-cmds.md`
* 相关测试：`tests/tui-footer.test.ts`、`tests/tui-extension.test.ts`、`tests/system-prompt-extension.test.ts`

## 目标

新增命令：

```text
/stats
```

行为：

* 仅 TUI 模式启用。
* 在 TUI 中打开一个只读 custom UI 浮层。
* 不经过模型，不消耗模型 token。
* 不写入会话历史。
* `Esc`、`q`、`Enter` 关闭。
* `↑/↓`、`PageUp/PageDown`、`Home/End` 滚动。
* 默认展示当前 session 的统计快照，第一版必须包含 context breakdown。
* 非 TUI 模式下使用 `ctx.ui.notify("/stats requires TUI mode", "error")` 或等价错误提示，不要抛异常。

## 推荐新增文件

优先采用下面结构；如果实际 Pi 类型要求调整，可以小幅重命名，但保持职责清晰：

```text
agent/extensions/stats.ts
src/stats/types.ts
src/stats/collector.ts
src/stats/context-breakdown.ts
src/stats/render-stats.ts
src/stats/stats-viewer.ts
tests/stats-collector.test.ts
tests/stats-context-breakdown.test.ts
tests/stats-renderer.test.ts
tests/stats-viewer.test.ts
```

同时更新：

```text
docs/slash-cmds.md
README.md
```

如有必要，也可以轻微调整：

```text
agent/extensions/system-prompt.ts
src/tui/text.ts
```

但不要做大规模重构。

## UI 设计

`/stats` 打开后应类似 `/system` 的只读滚动 viewer，不要使用 `notify()` 输出大段文本。

默认布局如下，实际数据根据当前 session 生成：

```text
Stats · current session                                      q close  ↑↓ scroll

~/repo/o-pi ⑂ stats-ui*                         claude-sonnet · high · ready
ctx 86.4k / 200k  43.2% · cache hit 72.8% · $0.084 est · 12/14 tools

Context breakdown · current request window · ~estimated
[ system 14% ][ tools 18% ][ project 3% ][ history 39% ][ tool output 24% ][ Δ 2% ]

source                    tokens     share   note
system prompt             ~12.1k     14.0%   custom prompt + runtime context
tool definitions          ~15.5k     18.0%   12 active tools
project context            ~2.6k      3.0%   AGENTS.md / context files
conversation history      ~33.4k     38.7%   user + assistant messages
tool calls                 ~1.1k      1.3%   assistant tool arguments
tool outputs              ~20.8k     24.1%   read / grep / bash / webfetch
current user input           ~0.7k    0.8%   latest user message
unknown delta              ~2.0k      2.3%   provider overhead / estimator drift

Session usage
input 122k · output 18k · cache read 310k · cache write 44k · observed 494k
last turn 21k · avg/turn 13.7k · turns 18

Cache
latest hit 84.1% · total hit 70.3% · read/write 7.0x

Cost
total $0.084 est · last $0.006 est

Tools
37 calls · 35 ok · 2 failed
read 14 · grep 7 · edit 5 · bash 4 · webfetch 2
```

注意：

* Context breakdown 必须放在第一屏核心位置。
* 统计数如果是估算值，前缀使用 `~`。
* 成本必须显示 `est`，不要暗示它是权威账单。
* 缺失数据时隐藏字段或显示 `unknown`，不要伪造。
* 不要做复杂 dashboard、tabs、鼠标交互、可编辑 UI、sidebar、重型边框。
* 第一版只做 `/stats`，不要急着实现 `/stats --days`、`--project`、`--json` 等历史报表。

## 宽度适配

实现 renderer 时需要适配终端宽度。

### width >= 100

使用完整表格：

```text
source                    tokens     share   note
conversation history      ~33.4k     38.7%   28 messages
```

### 70 <= width < 100

使用短列名：

```text
source              tokens   %      note
history             ~33.4k   38.7   28 msgs
tool output         ~20.8k   24.1   read/grep/bash
```

### width < 70

使用单列紧凑布局，不显示 note：

```text
Context · 86.4k/200k · 43.2%
history        ~33.4k  38.7%
tool output    ~20.8k  24.1%
tools          ~15.5k  18.0%
system         ~12.1k  14.0%
```

所有输出行都必须用 `truncateToWidth`、`visibleWidth` 等可见宽度工具处理，避免中文、emoji、ANSI 颜色导致布局溢出。

## 数据模型

新增类似下面的类型。可根据实际类型检查微调，但字段语义保持不变。

```ts
export interface StatsSnapshot {
  session: SessionStats;
  usage: UsageStats;
  cache: CacheStats;
  context: ContextStats;
  tools: ToolStats;
  generatedAt: Date;
}

export interface SessionStats {
  cwd?: string;
  git?: string;
  modelId?: string;
  modelProvider?: string;
  modelReasoning?: boolean;
  thinkingLevel?: string;
  usingSubscription?: boolean;
  status?: string;
  userTurns: number;
  assistantTurns: number;
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalObservedTokens: number;
  lastTurnTokens?: number;
  averageTokensPerAssistantTurn?: number;
  costUsd?: number;
  lastCostUsd?: number;
}

export interface CacheStats {
  latestHitRate?: number;
  totalHitRate?: number;
  readWriteRatio?: number;
}

export interface ContextStats {
  totalTokens?: number;
  contextWindow?: number;
  percent?: number | null;
  remainingTokens?: number;
  confidence: "exact" | "estimated" | "mixed";
  items: ContextBreakdownItem[];
  notes: string[];
}

export interface ContextBreakdownItem {
  id:
    | "system"
    | "tool_definitions"
    | "project_context"
    | "subagents"
    | "conversation_history"
    | "tool_calls"
    | "tool_outputs"
    | "current_user"
    | "unknown_delta";
  label: string;
  tokens?: number;
  share?: number;
  estimated: boolean;
  note?: string;
}

export interface ToolStats {
  activeCount?: number;
  totalCount?: number;
  calls: number;
  successes?: number;
  failures?: number;
  byName: Array<{
    name: string;
    calls: number;
    failures?: number;
    durationMs?: number;
    outputChars?: number;
  }>;
}
```

## Session usage 采集

复用 `agent/extensions/tui.ts` 中已有的 `collectUsage(ctx)` 思路，但把它抽象成 `src/stats/collector.ts` 的纯函数。

从 `ctx.sessionManager.getEntries()` 遍历当前 session entries：

* 只统计 `entry.type === "message"` 且 `entry.message.role === "assistant"` 的 usage。
* 累加：

  * `usage.input`
  * `usage.output`
  * `usage.cacheRead`
  * `usage.cacheWrite`
  * `usage.cost.total`
* last turn 使用最后一条 assistant message 的 usage。
* `latestHitRate = cacheRead / (input + cacheRead + cacheWrite) * 100`
* `totalHitRate = totalCacheRead / (totalInput + totalCacheRead + totalCacheWrite) * 100`
* `readWriteRatio = cacheRead / cacheWrite`
* `totalObservedTokens = input + output + cacheRead + cacheWrite`
* 如果字段缺失或非 number，按 0 处理；不要抛异常。
* cost 只在大于 0 时展示，并且渲染时带 `est`。

注意：当前仓库的 footer 已经实现过类似逻辑。请避免重复散落两份逻辑。可以选择：

1. 把 `collectUsage` 从 `agent/extensions/tui.ts` 抽到 `src/stats/collector.ts`，footer 和 stats 共用；
2. 或保留 footer 逻辑，stats 另写纯函数，但测试覆盖一致性。

优先选择 1，除非会导致过大改动。

## Context breakdown 采集

Context breakdown 是第一版重点。它表示“当前下一轮请求窗口中，各来源大概占用了多少上下文”，不是累计 usage。

实现原则：

* `ctx.getContextUsage()` 是当前 context 总量的优先来源。
* breakdown 各项可以用本地估算 token 计数。
* 因为 provider 的真实 tokenizer 和 harness 内部包装可能不可见，所有 breakdown item 默认 `estimated: true`。
* 如果 `ctx.getContextUsage()?.tokens` 可用，则用它作为总量 denominator。
* 如果估算项总和小于 provider total，添加 `unknown_delta`。
* 如果估算项总和大于 provider total，允许按比例缩放各估算项到 provider total，并在 `ContextStats.notes` 加入 `known estimates scaled to provider total`。
* 如果 provider total 不可用，则用估算项总和作为 total，confidence 为 `"estimated"`。

### token 估算

不要引入重型依赖。实现一个本地、确定性的 `estimateTokens(text: string): number`：

* 空文本返回 0。
* ASCII 字符可近似 `chars / 4`。
* CJK 字符应更接近 1 字 1 token，可按 `cjkChars * 0.8~1.2`。
* 其他 Unicode 字符可按 `chars / 2`。
* 最终 `Math.ceil`。
* 该估算只用于相对占比，renderer 要显示 `~`。

测试里只断言相对稳定和基本范围，不要依赖真实模型 tokenizer。

### source 分类

从 `ctx.getSystemPromptOptions()` 和当前 session entries 中构造以下项：

#### `system`

包括：

* custom prompt
* append system prompt
* prompt guidelines
* runtime context，如 cwd、date
* system prompt XML wrapper/role/policy overhead
* 无法单独归类的 system prompt 残留部分

可以通过以下方式估算：

1. 使用当前 `agent/extensions/system-prompt.ts` 的 `buildSystemPrompt()` 或导出的 runtime build helper 生成最终 system prompt；
2. 单独估算 tool definitions、project context、subagents；
3. `system = max(0, fullSystemPromptEstimate - toolDefinitions - projectContext - subagents)`。

如果为了复用现有实际 system prompt 构建逻辑需要小改 `agent/extensions/system-prompt.ts`，可以导出一个 helper，例如：

```ts
export async function buildRuntimeSystemPromptForStats(
  options: BuildSystemPromptOptions,
  cwd: string,
  activeTools: string[],
): Promise<string>
```

但不要把 stats 逻辑塞进 system-prompt extension。

#### `tool_definitions`

从 `ctx.getSystemPromptOptions().toolSnippets` 和 `pi.getActiveTools()` 估算当前 active tools 的 prompt snippets。

* 只统计 active tools。
* note 显示 `N active tools`。
* 如果无 active tools，隐藏该项或 tokens 为 0。

#### `project_context`

从 `ctx.getSystemPromptOptions().contextFiles` 估算。

* note 可以显示文件数量，如 `2 context files`。
* 不要展开文件内容。

#### `subagents`

如果当前 `system-prompt.ts` 会给主 agent 注入 subagent index，应尽量复用相同逻辑估算。

可行方式：

* 复用 `loadSubagentConfig()`、`discoverAgents()`、`formatAvailableSubagentsPrompt()` 生成 subagent index；
* 只统计主 agent 可见的 subagent index；
* 不要统计子 agent 私有 system prompt；
* 若 `process.env.PI_SUBAGENT_CHILD === "1"`，该项应为 0 或隐藏。

#### `conversation_history`

统计用户和助手普通文本消息。

* user message 文本
* assistant normal text
* 不包含 tool call arguments
* 不包含 tool result output
* 最新一条 user message 可以单独放到 `current_user`

#### `current_user`

当前 session 最后一条 user message。

* 如果能从 session entries 中识别最后一条 user message，把它从 conversation history 中扣出来，单独显示。
* 如果识别不了，忽略该项。

#### `tool_calls`

assistant tool call arguments。

* 尽量从 message content 中识别 tool calls / tool_use / function_call / toolCalls 等常见结构。
* 对未知结构，安全 fallback 为 JSON.stringify 后估算，但不要把 usage/cost 元数据重复算进去。
* 失败时不要抛异常。

#### `tool_outputs`

tool result content。

* 尽量识别 role 为 `tool` 的 message、entry.type 类似 `tool_result` 的 entries、或 message content 中 type 为 `tool_result` 的块。
* note 可显示来源工具名摘要，例如 `read/grep/bash`，最多 3 个名字。
* 如果无法可靠识别，保留为 0 或隐藏。

#### `unknown_delta`

当 provider-reported context total 大于本地估算已知项时添加。

* label 显示 `unknown delta`
* id 为 `unknown_delta`
* estimated 为 true
* note 为 `provider overhead / estimator drift`
* 若 share > 10%，渲染时用 warning 色或 note 标记。

## Tool stats

第一版不强求做到完整 duration 统计，但要尽力提供有用信息。

实现优先级：

1. `activeCount` / `totalCount`：来自 `pi.getActiveTools()` / `pi.getAllTools()`，必须有。
2. calls by name：尽量从 session entries 中解析 tool calls/results。
3. successes / failures：如果能从 tool result 或 event 识别错误则展示；否则隐藏。
4. durationMs / outputChars：如果 session entries 或 public event 中可获取则展示；否则隐藏。

不要为了统计工具耗时而引入 hack。不要 monkey patch 工具执行器。不要读取私有内部状态。

如果 Pi 公开 event 类型支持 `tool_result`，可以在 `agent/extensions/stats.ts` 中维护一个轻量 runtime state，但必须：

* session_start 时重置。
* 不影响工具执行。
* 不写 session。
* 如果事件字段不可用，就只展示可用字段。

## StatsViewer

新增 `src/stats/stats-viewer.ts`，实现只读滚动 custom UI 组件，参考 `SystemPromptViewer`：

* 实现 `Component`
* 构造参数包含：

  * `snapshot: StatsSnapshot`
  * `theme: Theme`
  * `getRows: () => number`
  * `done: () => void`
* 支持关闭和滚动快捷键。
* render 时调用 `renderStats(snapshot, width, theme)` 得到 body lines。
* body 高度用终端 rows 的 75% 左右估算，和 `/system` 保持一致。
* 所有行都 `truncateToWidth` + pad 到 width。
* 不保存 `ExtensionContext`，只保存纯 snapshot。

## Renderer

新增 `src/stats/render-stats.ts`：

* 暴露 `renderStats(snapshot, width, theme): string[]`
* 纯函数，便于测试。
* 使用 Pi theme token：

  * title/accent: `accent`
  * dim text: `dim`
  * table header: `muted` 或 `dim`
  * warning: `warning`
  * error/large unknown delta: `error`
  * success/normal cache: `success`
* 不要硬编码大量 ANSI。少量已有 context gradient 可以不复制。
* 使用 `formatTokens`、`formatDuration`、`joinParts` 等工具；如有必要，把 `formatTokens` 从 footer 内部提取到 `src/tui/text.ts`，避免重复。

建议新增到 `src/tui/text.ts`：

```ts
export function formatTokens(value: number): string
export function formatPercent(value: number): string
export function formatUsd(value: number): string
```

如果不想改公共 text 工具，也可以在 stats renderer 内部实现本地函数，但要有测试。

## `/stats` extension 注册

新增 `agent/extensions/stats.ts`：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectStatsSnapshot } from "../../src/stats/collector.js";
import { StatsViewer } from "../../src/stats/stats-viewer.js";

export default function statsExtension(pi: ExtensionAPI): void {
  pi.registerCommand("stats", {
    description: "Show current session statistics.",
    async handler(_args, ctx) {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/stats requires TUI mode", "error");
        return;
      }

      const snapshot = await collectStatsSnapshot(ctx, pi);
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new StatsViewer(snapshot, theme, () => tui.terminal.rows, done),
      );
    },
  });
}
```

实际类型以仓库依赖为准。请先 typecheck。

## 测试要求

新增 Vitest 测试，至少覆盖：

### collector

* 能从 assistant usage 累加 input/output/cacheRead/cacheWrite/cost。
* 能计算 latest cache hit rate 和 total cache hit rate。
* 没有 usage 时不崩溃，返回 0 或 undefined。
* subscription 模式不会把 cost 伪造成真实账单。
* active tools count 来自 `pi.getActiveTools()` / `pi.getAllTools()`。

### context breakdown

* 能把 system/tool definitions/project context/conversation history/tool outputs/current user/unknown delta 分开。
* provider total 大于估算总和时添加 `unknown_delta`。
* 估算总和大于 provider total 时进行缩放或至少保证 share 总和不超过约 100%。
* contextFiles 为空、toolSnippets 为空、entries 为空时不崩溃。
* subagent child 环境变量下不统计主 agent subagent index。

### renderer

* 宽屏下显示完整 table。
* 中宽下显示紧凑 table。
* 窄屏下显示单列布局。
* cost 带 `est`。
* estimated tokens 带 `~`。
* 所有行 visibleWidth 不超过 width。
* unknown delta 超过 10% 时有 warning/error 语义。
* 缺失字段时隐藏，不显示 `undefined`、`NaN`、`Infinity`。

### viewer

* `q` / `Esc` / `Enter` 能关闭。
* 上下滚动不会越界。
* PageUp/PageDown/Home/End 行为正常。
* render 极窄宽度不崩溃。

### extension

* 注册 `/stats` 命令。
* TUI 模式下调用 `ctx.ui.custom`。
* 非 TUI 模式下 notify error。
* command 不 appendEntry，不写 session history。

## 文档更新

更新 `docs/slash-cmds.md`，新增：

````md
## `/stats`

来源：`agent/extensions/stats.ts`

用途：在 TUI 中只读查看当前会话统计量，包括 context breakdown、token usage、cache、cost 和工具概览。

用法：

```text
/stats
````

行为：

* 仅支持 TUI 模式。
* 通过 custom UI 展示，不写入会话历史。
* Context breakdown 是当前 request window 的估算拆分，不等于累计 usage。
* token/cost/cache usage 来自 provider-reported assistant message usage；cost 是 estimated。
* 关闭：`Esc`、`q` 或 `Enter`。
* 滚动：方向键、`PageUp`、`PageDown`、`Home`、`End`。

```

同时在 `README.md` 的文档列表中补充 slash command 或 stats 说明。

## 质量约束

- 通过 `npm run typecheck`
- 通过 `npm test`
- 不引入新依赖，除非绝对必要；本任务应不需要新依赖。
- 不读取网络。
- 不改现有工具语义。
- 不改变 `/system`、`/tools`、footer、tool card 的行为，除非是为了抽取共享纯函数，且测试通过。
- 不输出 raw session JSON、完整 system prompt、完整 tool output；`/stats` 只展示摘要。
- 所有统计都要 best-effort、安全降级；不要因为某个 provider 字段缺失而崩溃。
- 所有估算值必须在 UI 上体现为 estimated，比如 token 前缀 `~` 或 section 标注 `~estimated`。
- 代码应偏纯函数和小模块，不要把所有逻辑塞进 extension 文件。

完成后请给出：

1. 修改文件列表。
2. `/stats` 的最终 UI 示例。
3. 已运行的检查命令和结果。
4. 如果某些统计因为 Pi public API 不可得而只能隐藏或估算，请明确说明。
```
