# Pi TUI 使用技巧

输入 `/hotkeys` 可查看当前版本的全部快捷键。以下只保留最实用的部分。

> macOS 上 `Ctrl` 指 **Control**，不是 Command；`Alt` 指 **Option**。为兼容各平台，优先使用 `Ctrl` 和 `Alt`，不要依赖 `Super`（Windows 键 / Command）。

## 高频快捷键

| 快捷键 | 作用 |
|---|---|
| `Shift+Enter` / `Ctrl+J` | 换行 |
| `@` / `Tab` | 搜索文件 / 补全路径 |
| `Ctrl+G` | 用外部编辑器编写长提示词 |
| `Ctrl+X` | 复制上一条助手回复 |
| `Ctrl+O` / `Ctrl+T` | 折叠工具输出 / thinking |
| `Shift+Tab` | 切换思考等级 |
| `Ctrl+L` | 选择模型 |
| `Ctrl+P` / `Ctrl+Shift+P` | 前后切换模型 |
| `Ctrl+-` | 撤销编辑 |
| `Escape` | 取消或中止 |

编辑输入时还可使用 `Ctrl+A/E` 跳到行首/行尾、`Ctrl+W` 删除单词、`Ctrl+U/K` 删除到行首/行尾、`Ctrl+Y` 恢复删除内容，以及 `Up/Down` 浏览输入历史。

## Agent 工作时继续输入

- `Enter`：发送 steering，当前工具调用结束后尽快纠偏。
- `Alt+Enter`：发送 follow-up，等当前任务全部结束后执行。
- `Alt+Up`：将排队消息取回编辑器。
- `Escape`：中止执行并恢复排队消息。

发现方向不对时，不必等 Agent 跑完，直接输入纠正要求并按 `Enter`。

## 文件、图片和 Shell

- 输入 `@` 引用文件，输入路径后按 `Tab` 补全。
- 图片可拖入终端；Pi 默认用 `Ctrl+V` 粘贴图片，Windows 上可能是 `Alt+V`。
- macOS 的 `Command+V` 通常只负责终端文本粘贴；图片优先使用 `Control+V` 或拖入。
- `!git status`：执行命令并将输出发给模型。
- `!!git status`：只执行命令，不占用模型上下文。

## Fullscreen

长会话可在 `/settings` 中启用 fullscreen：

- `PageUp/PageDown`：翻页
- `Home/End`：顶部/底部
- `Ctrl+Shift+Up/Down`：上一条/下一条用户消息
- `Ctrl+Shift+F`：搜索对话

macOS 键盘可能需要配合 `Fn`。若更依赖终端原生 scrollback，则保留 `regular` 模式。

## 会话与分支

```text
/name 重构登录模块   # 命名当前会话
pi -c                # 继续最近会话
pi -r                # 搜索历史会话
```

- `/tree`：回到任意节点，尝试另一种方案。
- `/fork`：从旧消息创建独立会话。
- `/clone`：复制当前活动分支。
- `/compact 保留当前状态、决策和未解决问题`：压缩长上下文。

默认双击 `Escape` 会打开 `/tree`。其中 `Alt+Left/Right` 折叠或展开分支，`Shift+L` 添加标签，`Ctrl+O` 切换过滤模式。与其在错误方向上不断追加纠正，不如回到较早节点重新提问。

## 减少重复输入

将编码规范和验证要求写入项目的 `AGENTS.md`，个人通用偏好写入 `~/.pi/agent/AGENTS.md`。

重复任务可做成 Prompt Template。例如创建 `~/.pi/agent/prompts/review.md`：

```markdown
---
description: 审查当前改动
argument-hint: "[关注点]"
---
审查 git diff，重点检查逻辑错误、复杂度和错误处理。
额外关注：${ARGUMENTS:-无}
```

之后输入 `/review 并发安全` 即可展开。项目模板放在 `.pi/prompts/`。

## 推荐配置

全局配置位于 `~/.pi/agent/settings.json`，项目配置位于 `.pi/settings.json`：

```json
{
  "tuiMode": "fullscreen",
  "fullscreenExitOutput": "resume-hint",
  "quietStartup": true,
  "doubleEscapeAction": "tree",
  "treeFilterMode": "no-tools",
  "autocompleteMaxVisible": 10,
  "externalEditor": "nvim"
}
```

- VS Code 用户将 `externalEditor` 设为 `"code --wait"`。
- 中文输入法候选框位置异常时，设置 `"showHardwareCursor": true`。
- 用 `/scoped-models` 只保留少数常用模型。
- 自定义快捷键写入 `~/.pi/agent/keybindings.json`。
- 修改设置、模板或快捷键后执行 `/reload`。

## 终端兼容

组合键失效通常是终端拦截，而不是 Pi 的问题：

- Windows Terminal 可能占用 `Alt+Enter`。
- macOS WezTerm、Alacritty 可能无法直接传递 `Option+Enter`。
- Apple Terminal 通过 SSH 时可用 `Ctrl+J` 代替无法识别的 `Shift+Enter`。
- iTerm2 fullscreen 滚动过慢时，将 **Trackpad scrolls fast?** 设为 **No**。
- Kitty、Ghostty、WezTerm 等现代终端通常能更可靠地区分组合键。

需要修改终端映射时参考 [Pi Terminal setup](https://pi.dev/docs/latest/terminal-setup)。
