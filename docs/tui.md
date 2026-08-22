# TUI

`agent/extensions/tui.ts` 提供 o-pi 的 TUI 界面框架，并保留 Pi 原生的单列会话记录。输入框通过公开的 `CustomEditor` 和 `setEditorComponent()` 支持按路径保存操作历史。空会话启动时，`fullscreen` 模式显示主页，`regular` 模式显示启动横幅。其他区域只使用当前本地 Pi 依赖公开的 UI API，增加标题、页眉、页脚、状态和工作指示器。

`fullscreen` 模式的主页以原生输入框为中心。主页上方显示响应式 `O Pi` 字标，下方显示项目、上下文、工具、Skill 和能力。主页根据终端宽高选择完整、中等或紧凑布局。

`regular` 模式显示轻量启动横幅，输入框保持常规高度。宽终端中的横幅左右排列，窄终端中的横幅上下排列。终端宽度小于 44 列时，横幅退化为紧凑文本，避免在终端回滚记录中插入全屏主页。提交第一条非空输入时，启动界面立即隐藏。`turn_start` 事件也会确保启动界面在首轮开始时隐藏。恢复已有会话时不显示启动界面。

## 边界

实现不分叉 Pi 代码，不动态修改现有实现，不使用覆盖层，也不维护第二套输入框。`fullscreen` 模式的主页由继承 Pi `CustomEditor` 的同一个编辑器渲染。`regular` 模式的启动横幅使用 Pi 公开的 `setHeader()` API，输入框保持常规高度。两种模式均保留原生编辑、硬件光标、中文输入法、自动补全、快捷键和提交语义。

整个 o-pi TUI 运行时只在 Pi 原生 TUI 中启用，此时 `ctx.mode === "tui"`。界面框架、主页、页脚、Git 状态、数学 Markdown、工具或消息渲染器以及命令查看器都不会在 RPC、JSON 或打印模式中初始化。

非 TUI 模式仍注册相同的工具模式、执行逻辑和结构化结果，但不绑定自定义渲染器。TUI 专用命令会使用原有的错误通知或降级为纯文本。重新加载会话时会复用原生运行时。关闭会话时会清理界面框架、计时器和 Git 查询状态。

架构测试将代码依赖方向固定为 `data/query/service/controller -> adapter -> TUI`。只有 `src/tui/**` 和功能自己的 `tui/` 目录可以在运行时导入 `pi-tui`。扩展只能动态加载功能对应的 TUI。

首次加载失败时，系统会保留核心注册，并允许下一个 TUI 会话重试。失败不会影响应用层 Promise、结构化结果或非 TUI 启动。未来的 GUI 或 RPC 适配器应消费 DTO、结果和进度，不得把斜杠命令文本、通知文本或组件当作 API。

## 启用

把本仓库作为 `~/.pi` 使用时，Pi 会加载：

```text
agent/extensions/tui.ts
agent/defaults/tui.jsonc
```

配置缺失时使用默认值。配置错误会抛出明确错误。

Math Markdown 解析器和 MathJax 不在 `session_start` 热路径加载。启用数学渲染时，native TUI 会在连续空闲 750ms 后初始化。`turn_start` 会取消等待，`turn_end` 再重新安排。支持终端图片的环境会同时预热 MathJax。如果预热尚未完成就首次遇到块级公式，renderer 会先显示源码并按需启动初始化，后续重绘显示公式图片。RPC、JSON 和 print 模式不会加载整个 TUI runtime 或这套 TUI 数学能力，session 关闭也会取消尚未开始的任务。

## 路径级操作历史

TUI 将键盘提交的 prompt、slash command、`!`/`!!` 和 follow-up 统一写入：

```text
~/.pi/cache/user-history/history.jsonl
```

这是唯一的持久化历史文件。每行是一条可人工查看和编辑的 JSON 记录。多行输入在 JSON 字符串中转义：

```json
{"timestamp":"2026-08-07T12:34:56.789Z","cwd":"/home/user/project","session":"...","text":"检查这个改动"}
```

历史按规范化绝对 `cwd` 隔离，而不是按 session 隔离。新会话或恢复其他会话时，只把当前路径最近 100 条载入 Pi 原生上下方向键历史。当前草稿的恢复、单行/多行光标移动规则仍沿用 Pi。首次启用时会从当前 session 补入尚未进入该文件的旧用户消息，但 session transcript 的启动回放不会再次写盘。

提交热路径不等待磁盘：记录进入进程内串行写队列，再以 JSONL 追加。多个 Pi 进程通过短期目录锁协调写入。启动加载从文件尾按 64 KiB 分块反向扫描，收满当前路径 100 条即停止。文件超过 8 MiB 时在写锁内压缩到约 6 MiB，每个路径最多保留 100 条。异常退出留下的锁超过 30 秒会被回收。历史加载或保存失败只警告一次，不影响输入和 Agent 执行。

模型正文完成后，消息时间戳左侧显示 `[TPS: ..., TTFT: ...]`，两个方括号块之间不留空格。TPS 只统计正文 `text_delta`，不包含 thinking、reasoning summary、隐藏 reasoning 或工具参数。TTFT 从最后一次实际 HTTP attempt 开始，计算到首个用户可见模型 token。思考内容展开时首个 thinking token 可作为 TTFT 终点，隐藏时则使用首个正文 token。正文只有一个流式观测点、请求失败或终端宽度不足时只保留时间戳。性能数据只属于当前 TUI 进程，不写入 session 历史。

## 系统通知

TUI 在 `agent_settled` 触发后通过 `node-notifier` 发送系统通知，确保自动重试、压缩和排队 continuation 均已结束。RPC、JSON 和 print 模式不发送完成通知。权限审批仅在策略返回 `ask` 且交互 UI 可用时，于打开选择框前发送通知。标题固定为 `o-pi`，正文固定为 `o-pi is waiting for you.`。

通知后端按平台使用 Linux `notify-send`、macOS Notification Center 或 Windows Toast。依赖加载和通知发送均采用尽力而为策略，任何失败都不会阻塞 Agent 结束或权限审批。

## 配置

默认配置位于 `agent/defaults/tui.jsonc`，用户覆盖位于 `agent/configs/tui.jsonc`。不读取项目配置。分层规则见[配置分层](configuration.md)。可配置字段：

* `enabled`: 开关。
* `preset`: 保留的兼容字段。当前 renderer 不按该值分支。
* `icons`: 保留的兼容字段。当前全局配置不改变各工具 renderer 的图标选择。
* `chrome.title/header/footer`: 控制轻量 chrome。
* `chrome.working_indicator`: `dot`、`spinner`、`off`。
* `home.enabled`: 空会话启动界面的开关。
* `home.motion`: `off`、`subtle` 或 `playful`。控制全屏主页的动画等级。`playful` 增加低频 Pi Core 轨道。相关定时器会按类型在动画完成、首轮开始或会话清理时释放。
* `home.pointer_effects`: `off`、`click` 或 `click-hold`。控制全屏主页的鼠标反馈。
* `home.show_tagline`: 是否在全屏主页的字标下方显示标语。
* `home.show_tips`: 是否在全屏主页中显示按会话稳定选择的提示。
* `home.show_hints`: 是否显示启动操作提示。全屏主页在页脚显示，启动横幅在横幅正文中显示。
* `home.show_capabilities`: 是否在全屏主页和启动横幅中显示 `files`、`web`、`bash`、`skill`、`subagent` 能力分组。
* `footer.segments`: 宽屏字段。
* `footer.narrow_segments`: 窄屏字段。
* `footer.max_lines`: schema 固定为 `2`，renderer 不读取该值做动态布局。
* `footer.style.workspace_color`: workspace 路径颜色，使用 Pi theme token。
* `footer.style.git_color`: git 分支颜色，使用 Pi theme token。
* `tools.*`: 保留的兼容字段。当前工具 renderer 使用各自稳定的两行布局和默认截断预算，不读取这组全局配置。

footer 最多两行：

```text
<workspace · git>                                      <context>
<tokens · cache · cost>                  <active>/<total> tools
```

窄屏第一行使用 `footer.narrow_segments`，两行都会按终端可见宽度截断。workspace 不带 `cwd` 前缀，`$HOME` 下路径显示为 `~/coding/project`。workspace、git 和 context 百分比保留彩色。其他 footer 文本使用 `dim`，避免抢占视线。context、token、cache、cost 展示规则跟随 Pi 原版 footer：`↑/↓`、cache read/write、最近和累计 cache 命中率、`percent/window`、subscription cost 标记，以及支持 reasoning 的模型 thinking level。context 使用量按百分比从绿色渐变到红色。

## 启动界面

全屏主页和启动横幅只显示真实可得的数据。缺少模型、上下文或 Git 状态时，对应字段会隐藏。Pi 版本来自 `@earendil-works/pi-coding-agent` 导出的 `VERSION`，不会使用本仓库 `o-pi` 的包版本代替。

全屏主页将模型、提供商和思考级别显示在输入框上边框，将就绪状态和可用提供商数量显示在下边框。项目、上下文和能力摘要位于输入框下方。启动横幅按行显示 Pi 版本、工作区、模型、上下文、工具和 Skill。

工具能力使用语义分组，不从扩展文件名推断。启动界面按固定顺序显示：

```text
files:6 web:2 bash subagent skill
```

`files` 和 `web` 显示启用数量。`bash`、`subagent` 和 `skill` 是单项能力，因此不显示 `:1`。部分关闭时，多工具分组显示为 `files:3/4`。完全未启用的能力仍会显示，但使用 `dim` 颜色。斜杠命令不计入工具数量。

`skill` 的颜色和启用状态对应实际的 `skill` 工具。未归组工具不显示为 `other`。Skill 总数来自 Pi 公开的 `pi.getCommands()`，统计其中 `source: "skill"` 的命令。同名 Skill 只计一次，项目级 Skill 始终覆盖用户级 Skill。统计结果不依赖系统提示词是否列出 Skill，也不计入工具的 `active/total`。

全屏主页不使用页眉模拟，而由 `setEditorComponent()` 安装的同一个 `CustomEditor` 承载。主页显示期间，页眉为空，页脚显示操作入口和版本。宽屏字标右侧带有 Pi Core 图形，整个品牌区域约占 51 列。中等宽度使用约 40 列的紧凑 Pi Core，窄屏只显示文字标识。字标使用限时逐行组装和主题色流光。`playful` 模式下，Pi Core 以低频轨道相位活动，不响应键盘输入。入场定时器在动画完成后释放。轨道定时器在首轮开始或会话清理时释放。

`regular` 模式使用轻量启动横幅和常规页脚。终端宽度至少为 96 列时，ASCII 字标与 `pi`、`workspace`、`model`、`context`、`tools`、`skills` 状态左右排列。终端宽度为 44 至 95 列时，各部分上下排列。终端宽度小于 44 列时，横幅退化为文本摘要。`home.show_hints` 和 `home.show_capabilities` 分别控制操作提示和能力摘要。`regular` 模式不启动主页动画或鼠标反馈。

全屏主页会被动观察 Pi 已启用的 SGR 1006 鼠标序列，但不消费或改写输入。单击产生波纹。双击触发 `π` 粒子。使用 `click-hold` 时，长按 450 毫秒会使 Pi Core 蓄力并牵引字标，松开时从 Pi Core 产生爆炸效果。拖动、滚轮和非左键事件仍由 Pi 处理。非 TTY 环境、`regular` 模式或不支持鼠标的终端会静默退化。监听器和定时器在首轮开始或会话清理时释放。

首轮对话前通过 `/model` 或快捷键切换模型时，Pi 会触发 `model_select`。TUI 会重建当前快照，并通过公开的 UI 重绘入口更新当前启动界面、页脚和终端标题。单独切换思考级别时，TUI 会执行相同的更新。

## 工具卡片

普通工具的 collapsed view 固定 2 行：

```text
<icon> <tool>   <target>
  <summary> · <metrics> · <status>
```

expanded view 先保留这 2 行，再追加详情。renderer 会清理 ANSI、OSC 和控制字符。折叠态不输出原始 JSON、源码正文、diff 或网页结果列表。`edit` 的预览 diff 和结果 diff、`write` 的正文预览和结果 diff 都只在展开态显示。`webfetch` 展开态将响应、正文、覆盖和请求状态压成紧凑分组，并展示前 40 行、最多 6000 字符的正文。折叠态摘要仍保留变更行数、字节数和 LSP 状态。

文件工具失败结果默认仍折叠为 2 行。展开后显示模型实际发送的工具参数和结构化错误字段，包括 code、message、path、edit index、next 和 details。

## 已统一的渲染器

* `grep`
* `find`
* `read`
* `write`
* `edit`
* `ls`
* `webfetch`
* `websearch`
* `subagent`

`bash` 保留 Pi 内置 renderer。原因是当前内置 renderer 已处理 streaming、截断、图片块、`fullOutputPath` 和 `truncation` 展示。本仓库的 bash 工具继续提供这些 details，避免为了统一外观损失可用性。

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
