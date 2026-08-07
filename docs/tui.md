# TUI V1

`agent/extensions/tui.ts` 提供 o-pi 的轻量 TUI chrome。它保留 Pi 原生单列 transcript；输入框使用 Pi 公开 `CustomEditor/setEditorComponent` 扩展路径级操作历史，其余部分只通过当前本地 Pi 依赖的公开 UI API 增加 title、可选 header、footer/status 和 working indicator。

启动时会显示轻量 ASCII banner：左侧是 `O Pi` wordmark，右侧是当前可得的 workspace、model、context、tools 状态。宽终端左右排列，窄终端上下排列，极窄终端降级为 compact text；所有行都会按终端可见宽度截断。

## 边界

V1 不 fork、不 monkey patch、不替换主 TUI，不实现 sidebar、fixed editor、overlay、splash、重型 syntax theme、image paste 或 dashboard。自定义输入框继承 Pi `CustomEditor`，未改写原生编辑、自动补全、快捷键和提交语义，只预载并记录历史。目标是统一视觉语法，而不是重写交互框架。

整个 o-pi TUI runtime 只在 Pi native TUI (`ctx.mode === "tui"`) 中启用：chrome、startup banner、footer、Git 状态、Math Markdown、工具/消息 renderer 和 command viewer 都不会在 RPC、JSON 或 print 模式初始化。非 TUI 模式仍注册相同的工具 schema、执行逻辑和结构化结果；自定义 renderer 不绑定，TUI 专用命令使用原有的错误通知或纯文本降级。session reload 会复用 native runtime，session shutdown 会清理 chrome、timer 和 Git 查询状态。

代码依赖方向由架构测试固定为 `data/query/service/controller -> adapter -> TUI`。只有 `src/tui/**` 和 feature 自己的 `tui/` 目录可以运行时导入 `pi-tui`；extension 只能动态加载 feature TUI。首次加载失败会保留核心注册并允许下一次 TUI session 重试，不会影响 application promise、结构化结果或非 TUI 启动。未来 GUI/RPC adapter 应消费 DTO、outcome 和 progress，不能把 slash 文本、notification 文本或 component 当作 API。

## 启用

把本仓库作为 `~/.pi` 使用时，Pi 会加载：

```text
agent/extensions/tui.ts
agent/defaults/tui.jsonc
```

配置缺失时使用默认值；配置错误会抛出明确错误。

Math Markdown 解析器和 MathJax 不在 `session_start` 热路径加载。启用数学渲染时，native TUI 会在连续空闲 750ms 后初始化；`turn_start` 会取消等待，`turn_end` 再重新安排。支持终端图片的环境会同时预热 MathJax；如果预热尚未完成就首次遇到块级公式，renderer 会先显示源码并按需启动初始化，后续重绘显示公式图片。RPC、JSON 和 print 模式不会加载整个 TUI runtime 或这套 TUI 数学能力，session 关闭也会取消尚未开始的任务。

## 路径级操作历史

TUI 将键盘提交的 prompt、slash command、`!`/`!!` 和 follow-up 统一写入：

```text
~/.pi/cache/user-history/history.jsonl
```

这是唯一的持久化历史文件。每行是一条可人工查看和编辑的 JSON 记录；多行输入在 JSON 字符串中转义：

```json
{"timestamp":"2026-08-07T12:34:56.789Z","cwd":"/home/user/project","session":"...","text":"检查这个改动"}
```

历史按规范化绝对 `cwd` 隔离，而不是按 session 隔离。新会话或恢复其他会话时，只把当前路径最近 100 条载入 Pi 原生上下方向键历史；当前草稿的恢复、单行/多行光标移动规则仍沿用 Pi。首次启用时会从当前 session 补入尚未进入该文件的旧用户消息，但 session transcript 的启动回放不会再次写盘。

提交热路径不等待磁盘：记录进入进程内串行写队列，再以 JSONL 追加；多个 Pi 进程通过短期目录锁协调写入。启动加载从文件尾按 64 KiB 分块反向扫描，收满当前路径 100 条即停止。文件超过 8 MiB 时在写锁内压缩到约 6 MiB，每个路径最多保留 100 条；异常退出留下的锁超过 30 秒会被回收。历史加载或保存失败只警告一次，不影响输入和 Agent 执行。

模型正文完成后，消息时间戳左侧显示 `[TPS: ..., TTFT: ...]`，两个方括号块之间不留空格。TPS 只统计正文 `text_delta`，不包含 thinking、reasoning summary、隐藏 reasoning 或工具参数；TTFT 从最后一次实际 HTTP attempt 开始，计算到首个用户可见模型 token。思考内容展开时首个 thinking token 可作为 TTFT 终点，隐藏时则使用首个正文 token。正文只有一个流式观测点、请求失败或终端宽度不足时只保留时间戳。性能数据只属于当前 TUI 进程，不写入 session 历史。

## 系统通知

TUI 在 `agent_settled` 触发后通过 `node-notifier` 发送系统通知，确保自动重试、压缩和排队 continuation 均已结束；RPC、JSON 和 print 模式不发送完成通知。权限审批仅在策略返回 `ask` 且交互 UI 可用时，于打开选择框前发送通知。标题固定为 `o-pi`，正文固定为 `o-pi is waiting for you.`。

通知后端按平台使用 Linux `notify-send`、macOS Notification Center 或 Windows Toast。依赖加载和通知发送均采用尽力而为策略，任何失败都不会阻塞 Agent 结束或权限审批。

## 配置

默认配置位于 `agent/defaults/tui.jsonc`，用户覆盖位于 `agent/configs/tui.jsonc`；不读取项目配置。分层规则见[配置分层](configuration.md)。可配置字段：

* `enabled`: 开关。
* `preset`: 保留的兼容字段；当前 renderer 不按该值分支。
* `icons`: 保留的兼容字段；当前全局配置不改变各工具 renderer 的图标选择。
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
* `footer.max_lines`: schema 固定为 `2`，renderer 不读取该值做动态布局。
* `footer.style.workspace_color`: workspace 路径颜色，使用 Pi theme token。
* `footer.style.git_color`: git 分支颜色，使用 Pi theme token。
* `footer.style.git_icon`: git 分支前缀 UTF-8 图标。
* `tools.*`: 保留的兼容字段；当前工具 renderer 使用各自稳定的两行布局和默认截断预算，不读取这组全局配置。

footer 最多两行：

```text
<workspace · git · extension status>           <model · ctx · status>
<tokens · cache · cost>                        <active>/<total> tools enabled
```

窄屏第一行使用 `footer.narrow_segments`，两行都会按终端可见宽度截断。TUI 自身的 ready/running 状态位于右侧。workspace 不带 `cwd` 前缀，`$HOME` 下路径显示为 `~/coding/project`。workspace、git 和 context 百分比保留彩色；其他 footer 文本使用 `dim`，避免抢占视线。模型、context、token、cache、cost 展示规则跟随 Pi 原版 footer：`↑/↓`、cache read/write、最近和累计 cache 命中率、`percent/window`、subscription cost 标记，以及支持 reasoning 的模型 thinking level。context 使用量按百分比从绿色渐变到红色。

## Startup banner

banner 只展示真实可得数据：没有 model、context 或 git 时直接隐藏对应行。Pi 版本来自 `@earendil-works/pi-coding-agent` 的 typed `VERSION` 导出；不会使用本仓库 `o-pi` 的 package version 伪装 Pi 版本。

工具能力使用语义分组，不从 extension 文件名推断。banner 按固定顺序显示：

```text
files:6 web:2 bash subagent skill
```

`files` 和 `web` 显示启用数量；`bash`、`subagent` 和 `skill` 是单项能力，因此不显示 `:1`。部分关闭时多工具分组显示为 `files:3/4`；完全未启用的能力仍保留，但使用 `dim` 颜色。Slash command 不计入 tools 数量。

`skill` 的颜色和启用状态对应实际 `skill` 工具；未归组工具不显示为 `other`。下方 skills 行保持原样：skills 总数来自 Pi 公开 `pi.getCommands()` 中 `source: "skill"` 的命令；同名 skill 只计一次，project skill 始终覆盖 user skill。这不依赖 system prompt 中是否展示 skills，也不计入 tools 的 `active/total`。

当前本地 Pi API 没有比 `ctx.ui.setHeader()` 更专门的 public startup banner 入口。本扩展只通过公开 header API 显示 banner；如果 `clear_on_first_turn` 为 true，第一轮 turn 开始后恢复普通 one-line header 或清空 header，让 Pi 内置 startup help/resources 行为保持原样。

首轮对话前通过 `/model` 或快捷键切换模型时，Pi 会触发 `model_select`。TUI 会重建当前快照并通过 `setStatus/setFooter/setHeader/setTitle` 公开 API 触发重绘，保证 startup banner、footer 和终端 title 同步更新。单独切换 thinking level 时同理。

## 工具卡片

普通工具的 collapsed view 固定 2 行：

```text
<icon> <tool>   <target>
  <summary> · <metrics> · <status>
```

expanded view 先保留这 2 行，再追加详情。renderer 会清理 ANSI、OSC 和控制字符；折叠态不输出原始 JSON、源码正文、diff 或网页结果列表。`edit` 的预览 diff 和结果 diff、`write` 的正文预览和结果 diff 都只在展开态显示；`webfetch` 展开态将响应、正文、覆盖和请求状态压成紧凑分组，并展示前 40 行、最多 6000 字符的正文；折叠态摘要仍保留变更行数、字节数和 LSP 状态。

文件工具失败结果默认仍折叠为 2 行；展开后显示模型实际发送的工具参数和结构化错误字段，包括 code、message、path、edit index、next 和 details。

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

从当前本地 `@earendil-works/pi-coding-agent` 类型确认：

* `ctx.ui.setStatus(key, text)`
* `ctx.ui.setTitle(title)`
* `ctx.ui.setFooter(factory)`
* `ctx.ui.setHeader(factory)`
* `ctx.ui.setWorkingIndicator(options)`
* `ctx.ui.setEditorComponent(factory)` / `ctx.ui.getEditorComponent()`
* `CustomEditor`
* `ctx.ui.custom(factory, options)`
* `ctx.getContextUsage()`
* `ctx.getSystemPromptOptions()`
* `ctx.model.baseUrl/provider/id`
* `ReadonlyFooterDataProvider`
* `model_select`
* `thinking_level_select`
* `pi.getActiveTools()`
* `pi.getAllTools()`
