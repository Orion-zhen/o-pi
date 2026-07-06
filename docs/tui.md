# TUI V1

`agent/extensions/tui.ts` 提供 o-pi 的轻量 TUI chrome。它保留 Pi 原生单列 transcript 和输入框，只通过 Pi 0.80.3 公开 UI API 增加 title、可选 header、footer/status 和 working indicator。

启动时会显示轻量 ASCII banner：左侧是 `O Pi` wordmark，右侧是当前可得的 workspace、model、context、tools 状态。宽终端左右排列，窄终端上下排列，极窄终端降级为 compact text；所有行都会按终端可见宽度截断。

## 边界

V1 不 fork、不 monkey patch、不替换主 TUI，不实现 sidebar、fixed editor、overlay、splash、重型 syntax theme、image paste 或 dashboard。目标是统一视觉语法，而不是重写交互框架。

## 启用

把本仓库作为 `~/.pi` 使用时，Pi 会加载：

```text
agent/extensions/tui.ts
agent/configs/tui.jsonc
```

配置缺失时使用默认值；配置错误会抛出明确错误。

## 配置

核心字段：

* `enabled`: 开关。
* `preset`: `compact` 或 `minimal`。
* `icons`: `unicode`、`ascii`、`nerd`、`auto`；V1 不强依赖 Nerd Font。
* `chrome.title/header/footer`: 控制轻量 chrome。
* `chrome.working_indicator`: `dot`、`spinner`、`off`。
* `banner.enabled`: 启动 banner 开关。
* `banner.style`: `ascii` 或 `compact`。
* `banner.layout`: `auto`、`side_by_side`、`stacked`、`tiny`。
* `banner.side_by_side_min_width`: `auto` 下左右布局的最小宽度。
* `banner.tiny_width`: `auto` 下 compact 降级宽度。
* `banner.show_hints`: 是否显示 `/stats`、`/tools`、`ctrl+o` 等启动提示。
* `banner.show_capabilities`: 是否显示能力分组摘要。
* `banner.clear_on_first_turn`: 第一轮 turn 开始时清除 startup banner，并恢复普通 header 或内置 header。
* `footer.segments`: 宽屏字段。
* `footer.narrow_segments`: 窄屏字段。
* `footer.max_lines`: 固定为 `2`。
* `footer.style.workspace_color`: workspace 路径颜色，使用 Pi theme token。
* `footer.style.git_color`: git 分支颜色，使用 Pi theme token。
* `footer.style.git_icon`: git 分支前缀 UTF-8 图标。
* `tools.max_target_chars/max_summary_chars`: 工具卡片截断长度。
* `tools.collapsed_lines`: 固定为 `2`。

footer 最多两行：

```text
<workspace · git>                              <model · ctx · status>
<tokens · cache · cost>                        <active>/<total> tools enabled
```

窄屏第一行使用 `footer.narrow_segments`，两行都会按终端可见宽度截断。workspace 不带 `cwd` 前缀，`$HOME` 下路径显示为 `~/coding/project`。workspace、git 和 context 百分比保留彩色；其他 footer 文本使用 `dim`，避免抢占视线。模型、context、token、cache、cost 展示规则跟随 Pi 原版 footer：`↑/↓`、cache read/write、最近和累计 cache 命中率、`percent/window`、subscription cost 标记，以及支持 reasoning 的模型 thinking level。context 使用量按百分比从绿色渐变到红色。

## Startup banner

banner 只展示真实可得数据：没有 model、context 或 git 时直接隐藏对应行。Pi 版本来自 `@earendil-works/pi-coding-agent` 的 typed `VERSION` 导出；不会使用本仓库 `o-pi` 的 package version 伪装 Pi 版本。

工具能力使用语义分组，不从 extension 文件名推断：

```text
files: ls/read/write/edit
search: find/grep
shell: bash
web: websearch/webfetch
agent: subagent
```

全部启用时显示 `files:4 search:2 shell:1 web:2 agent:1`；部分关闭时显示 `files:3/4`。未归组工具合并为 `other`。Slash command 只作为 hints/details 出现，不计入 tools 数量。

如果已加载 skills，banner 会在 tools 下方单独显示一行：

```text
skills    3 · user:2 · project:1
```

skills 数量来自 Pi 公开 `pi.getCommands()` 中 `source: "skill"` 的命令，并按 `sourceInfo.scope` 统计 user/project。temporary scope 只在存在时追加 `temp:n`。这不依赖 system prompt 中是否展示 skills，也不计入 tools 的 `active/total`。

Pi 0.80.3 没有比 `ctx.ui.setHeader()` 更专门的 public startup banner API。本扩展只通过公开 header API 显示 banner；如果 `clear_on_first_turn` 为 true，第一轮 turn 开始后恢复普通 one-line header 或清空 header，让 Pi 内置 startup help/resources 行为保持原样。

首轮对话前通过 `/model` 或快捷键切换模型时，Pi 会触发 `model_select`。TUI 会重建当前快照并通过 `setStatus/setFooter/setHeader/setTitle` 公开 API 触发重绘，保证 startup banner、footer 和终端 title 同步更新。单独切换 thinking level 时同理。

## 工具卡片

collapsed view 固定 2 行：

```text
<icon> <tool>   <target>
  <summary> · <metrics> · <status>
```

expanded view 先保留这 2 行，再追加详情。renderer 会清理 ANSI、OSC 和控制字符；折叠态不输出原始 JSON、源码正文、网页结果列表或 diff。

## 已统一的 renderer

* `grep`
* `find`
* `read`
* `write`
* `edit`
* `ls`
* `webfetch`
* `websearch`
* `subagent`

`bash` V1 保留 Pi 内置 renderer。原因是当前内置 renderer 已处理 streaming、截断、图片块、`fullOutputPath` 和 `truncation` 展示；本仓库的 bash 工具继续提供这些 details，避免为了统一外观损失可用性。

## 合并的旧扩展

已删除并合并：

* `agent/extensions/status-line.ts`: 状态更新并入 TUI footer/status。
* `agent/extensions/titlebar-spinner.ts`: title/working indicator 并入 TUI chrome。

## 已确认的 Pi API

从本地 `@earendil-works/pi-coding-agent@0.80.3` 类型确认：

* `ctx.ui.setStatus(key, text)`
* `ctx.ui.setTitle(title)`
* `ctx.ui.setFooter(factory)`
* `ctx.ui.setHeader(factory)`
* `ctx.ui.setWorkingIndicator(options)`
* `ctx.ui.custom(factory, options)`
* `ctx.getContextUsage()`
* `ctx.getSystemPromptOptions()`
* `ctx.model.baseUrl/provider/id`
* `ReadonlyFooterDataProvider`
* `model_select`
* `thinking_level_select`
* `pi.getActiveTools()`
* `pi.getAllTools()`
