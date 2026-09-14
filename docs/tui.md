# TUI

`src/extensions/tui.ts` 只在 `ctx.mode === "tui"` 时加载界面运行时。RPC、JSON 和 print 模式不加载这套运行时或数学图片后端。工具执行和结构化结果不依赖 TUI。

聊天保留 Pi 原生单列会话记录。空会话在 `fullscreen` 模式显示 Home，在 `regular` 模式显示启动横幅。已有会话直接进入聊天。

## 实现边界

输入框继承 Pi `CustomEditor`，使用公开的 `setEditorComponent()` 安装。自定义边框通过 `renderTopBorder()` 和 `renderBottomBorder()` 绘制，不解析原生渲染结果。原生编辑、历史导航、硬件光标、输入法、快捷键和补全继续由 Pi 管理。补全列表位于下边框之后，输入超出可见高度时保留原生滚动提示。

标题、页眉、页脚和工作指示器使用公开 UI API。以下两项例外需要局部原型补丁，不分叉 Pi 源码：

- `message-timestamp.ts` 增强内置用户、Skill 和助手消息组件。助手内容更新完整透传原生方法参数，包括 `isStreaming`。消息边距和全局思考隐藏设置仍读取 Pi 私有字段。
- `math-markdown.ts` 增强 `Markdown.render()`，读取原生 Markdown 的文本、主题、选项和边距。只将顶层独立块级公式提升为图片，其他内容交回 Pi。

这些补丁依赖本地 Pi 实现，升级依赖时需要运行消息和数学渲染测试。

### 代码职责

| 文件 | 职责 |
| --- | --- |
| `runtime.ts` | 事件接入、活动会话切换、通知和性能跟踪 |
| `session.ts` | 会话界面资源、编辑器安装、Home 显隐和 Git 订阅 |
| `snapshot.ts`、`types.ts` | 共用界面快照、工具和 Skill 统计、会话用量采集 |
| `session-editor.ts` | 原生输入增强、边框标签和 Home 容器 |
| `fullscreen-images.ts`、`kitty-frame.ts` | 当前终端实例的全屏 Kitty 图片输出顺序适配 |
| `home.ts`、`banner.ts`、`footer.ts` | 页面布局和纯数据渲染 |
| `brand.ts`、`home-animation.ts`、`home-pointer.ts` | 共用字标、动画生命周期和鼠标反馈 |
| `math-initialization.ts` | 空闲初始化、会话隔离和加载状态 |
| `math-markdown.ts`、`math-renderer.ts` | 公式块识别、终端图片与 MathJax 后端 |
| `user-history.ts` | 路径级 JSONL 历史存储 |

界面共用 `TuiSnapshot`。活动会话的工作目录、运行状态、思考级别、提供商数量、排队状态和工具集合是必需字段。模型、Git、上下文等不可得的数据继续省略。用量在会话和轮次事件中采集，工具启用集合、会话名称和排队状态在重绘时读取。

## 生命周期

- `session_start` 清理上一会话并加载配置。启动时可用当前分支消息补齐输入历史。
- 提交第一条非空输入时立即隐藏启动界面。`agent_start` 同样确保离开 Home，将状态改为 `running` 并取消尚未开始的数学初始化。
- `turn_end` 更新用量快照，状态仍为 `running`。
- Agent 运行中的 `ui_prompt_start` 将状态改为 `waiting`，`ui_prompt_end` 恢复 `running`。空闲时打开扩展界面不改变状态。
- `agent_settled` 将状态改为 `ready`，安排数学初始化，并通过 `node-notifier` 发送完成通知。TUI 运行时不在 `ui_prompt_start` 发送通知。
- 模型或思考级别变化时刷新快照，通过 `setStatus()` 请求重绘，不重建整套界面组件。
- 会话关闭时取消延迟任务，停用已安装的数学补丁，释放动画和 Git 订阅，恢复仍由本扩展持有的编辑器，并等待历史写队列完成。

系统通知采用尽力而为策略。失败不影响 Agent 状态。通知标题为 `o-pi`，正文为 `o-pi is waiting for you.`。

## 配置

默认配置为 `agent/defaults/tui.jsonc`，用户覆盖为 `agent/configs/tui.jsonc`，也可通过 `PI_TUI_CONFIG` 指定用户配置文件。不读取项目配置。配置加载器负责校验、合并和复制，TUI 层只剔除 `$schema` 元数据。详见[配置分层](configuration.md)和 `agent/schemas/tui.schema.json`。

| 字段 | 含义 |
| --- | --- |
| `enabled` | 界面和数学增强开关，不关闭完成通知 |
| `icons` | `unicode`、`ascii` 或 `nerd`，控制共享状态图标和 Git 图标 |
| `chrome.title/header/footer` | 轻量界面区域开关 |
| `chrome.working_indicator` | `dot`、`spinner` 或 `off` |
| `footer.segments`、`footer.narrow_segments` | 宽屏和小于 80 列时的页脚字段集合 |
| `footer.style.workspace_color/git_color` | 工作区和 Git 的 Pi 主题颜色 |
| `home.enabled` | 空会话启动界面开关 |
| `home.motion` | `off`、`subtle` 或 `playful` |
| `home.pointer_effects` | `off`、`click` 或 `click-hold` |
| `home.show_tagline/show_tips/show_hints/show_capabilities` | 标语、提示、操作入口和工具能力摘要开关 |
| `math.enabled` | 块级公式图片增强开关，不关闭 Pi 原生 LaTeX |
| `math.max_width_cells/max_height_cells` | 图片显示尺寸上限 |
| `math.svg_scale`、`math.foreground` | SVG 渲染比例和前景色 |

不支持 `preset`、`footer.max_lines` 或 `tools.*`。未知字段和非法值直接报错，不静默忽略。

## 启动界面和页脚

Home 将原生输入框置于页面中央。上边框展示模型、提供商和思考级别，下边框展示运行状态和提供商数量。输入框下方显示项目、上下文、工具和 Skill 统计。布局根据终端宽高缩减，空间不足时优先保留输入框。

`regular` 模式不扩展输入框高度。横幅在至少 96 列时左右排列，在 44 至 95 列时上下排列，小于 44 列时显示紧凑文本。该模式不启动 Home 动画或鼠标反馈。

`playful` 在入场动画之外保留低频 Core 轨道。鼠标单击产生波纹，双击触发粒子。`click-hold` 支持长按 450ms 蓄力和松开后的爆炸效果。拖动、滚轮和非左键操作仍交给 Pi。

鼠标控制器被动观察 stdin 中的 SGR 1006 序列，不消费或改写输入。不能直接改用 `onTerminalInput()`，因为当前 Pi fullscreen 的内置监听器会先消费鼠标事件。非 TTY 环境不安装观察器。退出 Home 或重建编辑器时释放旧实例的动效资源。

工具能力按 `files`、`web`、`bash`、`skill`、`subagent` 分组。未归组工具仍计入工具总数，但不增加额外分组。Skill 与工具分别统计，同名 Skill 按现有索引规则去重，项目级优先于用户级。

聊天页脚固定两个区域行：

```text
<workspace · git>                                      <context>
<tokens · cache · cost>                   tools <active>/<total>
```

字段在各自区域内保留配置顺序。第二行先预留成本和工具数量的宽度，再让 token 和缓存统计按剩余宽度缩减。Home 页脚优先保留右侧版本，聊天页脚采用双侧按比例截断，两者不共用截断策略。

## 路径级操作历史

键盘提交的 prompt、slash command、`!`/`!!` 和 follow-up 统一追加到：

```text
~/.pi/cache/user-history/history.jsonl
```

这是唯一的持久化历史文件，每行是一条可人工查看和编辑的 JSON 记录：

```json
{"timestamp":"2026-08-07T12:34:56.789Z","cwd":"/home/user/project","session":"...","text":"检查这个改动"}
```

历史按规范化绝对 `cwd` 隔离。新会话或恢复会话时加载当前路径最近 100 条。当前会话中尚未持久化的早期用户消息会补入初始历史，启动回放不再次写盘。

提交不等待磁盘。进程内写队列保证串行追加，短期目录锁协调多个 Pi 进程。加载从文件尾按 64 KiB 反向分块扫描，收满 100 条即停止。文件超过 8 MiB 后在锁内压缩到约 6 MiB，每个路径最多保留 100 条。压缩采用临时文件加原子替换。超过 30 秒的陈旧锁会被回收。历史加载或保存失败每会话只警告一次，不影响输入和 Agent 执行。

## 全屏 Kitty 图片

仍由 `pi-coding-agent` 启动并管理 `pi-tui`，没有独立宿主，也不调整鼠标滚轮步长。

针对 [Pi #8306](https://github.com/earendil-works/pi/issues/8306)，在现有编辑器工厂取得活动 TUI 引用后，适配该终端实例的 `write()`，不修改上游源码或全局原型。全屏同步帧先完成清行、背景和文字更新，再按原坐标绘制 Kitty 图片，最后恢复光标与属性。图片分块、裁剪参数、上传缓存和删除指令继续遵循 Pi 的输出。

适配器只保存当前可见图片的 placement，不保留图片数据。滚动条或弹窗的差分刷新清理图片覆盖行时，补发受影响图片的 placement，不重新上传图片。与图片无关的文字更新不触发补绘。

适配随会话安装和释放，离开 Home 时保留。Pi 切换 regular/fullscreen 时仍复用原有终端，只有 fullscreen 输出被改写。普通模式、退出后的记录回放及非交互入口不受影响。关闭 TUI 增强或使用 `--no-extensions` 时不安装此适配。iTerm2 全屏图片的上游限制不在本次修复范围内。

验证使用真实 Pi renderer 的输出及 Linux PTY 中的独立二进制，覆盖工具读取图片、公式图片、分块、裁剪、滚动条差分更新、窗口缩放和退出。PTY 验证的是输出协议，不等同于 Kitty、WezTerm 等终端的实际像素显示。升级 Pi 后需要重新运行这些回归测试。

## 数学与消息指标

数学模块不进入启动加载的关键路径。启动完成或 `agent_settled` 后连续空闲 750ms，且没有排队消息时，才尝试初始化。支持 Kitty 或 iTerm2 图片协议时加载 MathJax/Resvg 后端。MathJax 使用静态打包的 `mathjax-tex` 字体，无需动态加载字体模块。后端未就绪、加载失败或公式无法渲染时，继续使用 Pi 原生文本渲染。后端加载失败时由初始化边界告警，后续空闲或会话切换不再重试。旧会话任务不得更新新会话界面。

公式识别按源码顺序扫描，跳过代码围栏和已消费的公式块。支持顶层 `$$...$$`、`\[...\]` 及已有裸环境，不把引用或句内公式提升为图片。图片遵守终端可用宽度和配置尺寸上限，并保留 Kitty 滚动所需元数据。

消息时间戳使用本地时区。助手正文完成后，在时间戳左侧显示 `[TPS: ..., TTFT: ...]`。TPS 使用正文 token 估算和正文首尾流式观测间隔，不包含思考或工具参数。TTFT 从实际请求开始计算，全局隐藏思考时使用首个正文 token，否则也考虑首个思考 token。缺少有效计时、请求失败或宽度不足时，只显示时间戳。性能数据只保存在当前进程，不写入会话历史。

## 测试边界

生产模块不提供仅供测试替换的时钟、stdin、加载器、通知后端、历史路径或容量参数。测试通过模块模拟、系统时钟和临时 HOME 隔离外部依赖，并从实际入口验证行为。历史测试使用真实的 8 MiB 压缩阈值、6 MiB 目标和 100 条限制，不在生产代码中保留缩小测试数据的选项。默认配置测试夹具位于 `tests/tui/fixtures.ts`。

## 工具卡片

工具折叠卡片固定两行，目标和摘要分别采用 72、96 字符的截断预算。原始文本先清理终端控制序列，再截断和着色。展开视图保留卡片头部，再追加具体工具详情。

`bash` 保留 Pi 内置渲染器，以保留流式输出、截断、图片和完整输出文件信息。`BorderedScrollViewer` 继续供 `/stats`、`/usage` 和 `/telemetry` 共享键盘与滚动行为。
