# TUI V1

`agent/extensions/tui.ts` 提供 o-pi 的轻量 TUI chrome。它保留 Pi 原生单列 transcript 和输入框，只通过 Pi 0.80.3 公开 UI API 增加 title、可选 header、footer/status 和 working indicator。

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
* `pi.getActiveTools()`
* `pi.getAllTools()`
