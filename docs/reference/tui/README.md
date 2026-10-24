# TUI

TUI 调用 Pi 的 `main()`，复用终端输入、命令、排队和生命周期。日常操作见[使用指南](../../guides/tui.md)。

## 配置

默认文件为 [`agent/defaults/tui.jsonc`](../../../agent/defaults/tui.jsonc)，用户文件为 `~/.pi/agent/configs/tui.jsonc`，可用 `PI_TUI_CONFIG` 指定路径。

| 字段 | 含义 |
| --- | --- |
| `enabled` | 界面与数学增强开关 |
| `icons` | `unicode`、`ascii` 或 `nerd` |
| `chrome.title/header/footer` | 标题、页眉和页脚 |
| `chrome.working_indicator` | `dot`、`spinner` 或 `off` |
| `footer.segments/narrow_segments` | 宽屏与小于 80 列时的页脚字段 |
| `footer.style.workspace_color/git_color` | 工作区和 Git 主题颜色 |
| `home.enabled` | 空会话启动界面 |
| `home.motion` | `off`、`subtle` 或 `playful` |
| `home.pointer_effects` | `off`、`click` 或 `click-hold` |
| `home.show_tagline/show_tips/show_hints/show_capabilities` | 启动页内容 |
| `math.enabled` | 块级公式图片 |
| `math.max_width_cells/max_height_cells` | 公式显示尺寸 |
| `math.svg_scale/foreground` | SVG 比例和前景色 |

系统通知独立于 `enabled`，见[通知](../runtime/notifications.md)。

## 启动页与状态

空会话在 fullscreen 模式显示 Home，regular 模式显示横幅。提交首条非空输入或开始运行后切换到聊天。运行中等待交互显示 waiting，`agent_settled` 后显示 ready。

Home 按终端尺寸缩减内容，优先保留输入框。regular 横幅在 96 列以上左右排列，44–95 列上下排列，更窄时使用紧凑文本。

聊天页脚展示工作区、Git、上下文、用量、缓存、费用和工具数。上下文低于 70% 使用 success 色，70%–90% 使用 warning，90% 起使用 error。

虚拟模型显示所选模型与最近成功响应模型，思考级别取该响应。切回普通模型后恢复常规显示。

## 输入历史

三端共用：

```text
~/.pi/cache/user-history/history.jsonl
```

每条记录包含时间、工作目录、会话和输入文本。历史按规范化工作目录隔离，加载最近 100 条。

写入在后台串行执行，目录锁协调多个进程。文件超过 8 MiB 时压缩到约 6 MiB，每个目录最多保留 100 条。超过 30 秒的陈旧锁会回收。历史读写失败每会话警告一次。

## 工具与消息

工具折叠卡片使用目标和摘要两行，展开后显示详情。Bash 使用 Pi 内置渲染器保留流式输出和完整日志信息。

消息时间戳使用本地时区。GUI 和 TUI 按每个正文块独立估算生成速度，不合并不同正文块或请求。TPS =（本段正文词元数 − 首片段词元数）/ 首末片段到达间隔，排除首字等待、思考和工具执行时间。词元数由本地分词器估算，网络缓冲也会影响结果。正文收到 `text_end` 后结算速度。单片段、缺少计时或未完成的正文显示 `—`。GUI 在每个正文块下显示速度，用量和费用单独汇总。新消息的计时结果随会话保存，历史消息不回退到请求平均速度。TUI 的 TTFT 仍从请求开始计算，宽度不足时只显示时间戳。

## 图片与公式

支持 Kitty 或 iTerm2 图片协议时，空闲 750ms 后延迟初始化 MathJax/Resvg。顶层独立公式渲染为图片，代码围栏与句内内容交给 Pi。后端不可用时采用 Pi 文本渲染。

Kitty fullscreen 适配先完成文字与背景更新，再绘制图片并恢复光标。适配器保存可见 placement，差分刷新时补绘受影响图片。关闭终端增强后释放适配。

## 实现

`src/tui/extensions.ts` 装配呈现器，`shell/` 管理快照和生命周期，`editor/` 扩展 Pi `CustomEditor`，`chat/` 管理消息和工具，`views/` 提供弹窗，`terminal/` 处理图片协议。

消息时间戳和 Markdown 数学使用局部原型补丁，依赖 Pi 组件内部字段。升级 SDK 时应验证消息、公式和图片输出。测试入口见[测试](../runtime/testing.md)。
