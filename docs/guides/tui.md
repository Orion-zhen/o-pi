# TUI 使用指南

在项目目录运行 `opi`，输入任务并按 Enter 发送。输入 `/hotkeys` 可查看当前版本的快捷键。

macOS 的 Ctrl 指 Control，Alt 指 Option。

## 常用操作

| 快捷键 | 操作 |
| --- | --- |
| `Shift+Enter` / `Ctrl+J` | 换行 |
| `@` / `Tab` | 引用文件、补全路径 |
| `Ctrl+G` | 用外部编辑器编写输入 |
| `Ctrl+X` | 复制上一条助手回复 |
| `Ctrl+O` | 折叠工具输出 |
| `Ctrl+T` | 切换思考内容显示 |
| `Shift+Tab` | 切换思考等级 |
| `Ctrl+L` | 选择模型 |
| `Ctrl+P` / `Ctrl+Shift+P` | 前后切换模型 |
| `Ctrl+-` | 撤销编辑 |
| `Escape` | 取消或中止 |

输入框支持 `Ctrl+A/E` 跳到行首或行尾，`Ctrl+W` 删除单词，`Ctrl+U/K` 删除到行首或行尾，`Ctrl+Y` 恢复删除内容。Up/Down 浏览当前工作目录的输入历史。

## 任务运行时补充要求

- Enter 发送引导消息，在下一次可介入时处理。
- Alt+Enter 发送跟进消息，等当前任务结束后处理。
- Alt+Up 将排队消息取回输入框。
- Escape 中止执行并恢复排队消息。

## 文件、图片和命令

用 `@路径` 引用文件，Tab 补全路径。图片可以拖入终端，或用 Ctrl+V 粘贴。Windows 的图片粘贴键可能是 Alt+V。

```text
!git status     将命令输出加入模型上下文
!!git status    只执行命令
```

`!` 和 `!!` 是用户直接执行的 Shell 命令，不经过模型工具审批。

## 会话与分支

```bash
opi -c         # 继续最近会话
opi -r         # 选择历史会话
```

| 命令 | 操作 |
| --- | --- |
| `/name 名称` | 重命名会话 |
| `/tree` | 查看会话树并切换分支 |
| `/fork` | 从历史位置创建独立会话 |
| `/clone` | 复制当前活动分支 |
| `/compact 要求` | 压缩上下文 |
| `/prune` | 按成本估算裁剪历史工具事务 |
| `/prune restore` | 撤销最近一次可恢复的裁剪 |

默认双击 Escape 打开会话树。树中 Alt+Left/Right 折叠或展开分支，Shift+L 添加标签，Ctrl+O 切换过滤方式。

## 全屏与配置

在 `/settings` 中选择 fullscreen。全屏下 PageUp/PageDown 翻页，Home/End 跳到首尾，Ctrl+Shift+Up/Down 跳转用户消息，Ctrl+Shift+F 搜索对话。

常用 `settings.json` 配置：

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

VS Code 可将 `externalEditor` 设为 `"code --wait"`。中文输入法候选位置异常时，尝试 `"showHardwareCursor": true`。终端增强配置见 [TUI Reference](../reference/tui/README.md)。

## 减少重复输入

将项目规范写入 `AGENTS.md`，个人偏好写入 `~/.pi/agent/AGENTS.md`。

创建 `~/.pi/agent/prompts/review.md`：

```markdown
---
description: 审查当前改动
argument-hint: "[关注点]"
---
审查 git diff，重点检查逻辑错误和错误处理。
额外关注：${ARGUMENTS:-无}
```

重载后输入 `/review 并发安全`。项目模板可放在 `.pi/prompts/`。完整语法见[提示词模板](../reference/prompts/templates.md)。

组合键被终端拦截时，可调整终端映射，参见 [Pi Terminal setup](https://pi.dev/docs/latest/terminal-setup)。
