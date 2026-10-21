# Discord Presence

Presence 将活动发布到 SDK 后端电脑上的 Discord Desktop。配置开启且 `ctx.hasUI` 为 true 时启用，支持 TUI、GUI 和 RPC。

默认配置已启用，使用内置应用 ID。Discord Desktop 需正在运行并允许分享活动。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/presence`、`/presence status` | 查看开关、档位和连接状态 |
| `/presence on` | 临时开启当前会话 |
| `/presence off` | 临时关闭并退出协调组 |
| `/presence reload` | 重读配置，保留当前有效的临时覆盖 |
| `/presence profile <name>` | 临时切换档位 |

命令选择保存在当前会话，新会话重新使用配置。

## 配置

默认值见 [`discord-presence.jsonc`](../../../agent/defaults/discord-presence.jsonc)。用户文件为 `~/.pi/agent/configs/discord-presence.jsonc`，项目文件为 `.pi/configs/discord-presence.jsonc`。

```json
{ "enabled": false }
```

可将上述内容写入用户文件关闭全局发布，或写入项目文件只关闭该项目。

配置档位、模板和图片见[展示配置](configuration.md)，路径环境变量见[配置分层](../runtime/configuration.md)。

## 活动

模型开始一轮时显示 thinking，工具流式生成时切换到对应活动，结束后恢复仍在运行的上一个工具，全部结束后回到 thinking，任务结束后切到 idle。

文件名在路径字符串完整后提取，Shell 程序名在首个有效单词完整后提取。发布按 `update_interval_ms` 合并和限频，连接失败按 `retry_interval_ms` 重试最新状态。

## 隐私

默认 standard 档位发布通用活动、简化模型名、Shell 程序名和未分类工具名。detailed 还会发布项目基本名与文件基本名。使用自定义模板前检查占位符内容。

## 进程协调

同一系统用户的会话通过本地协调进程共享一个 Discord RPC 连接，最近发布活动者获得展示权。该会话退出后恢复剩余会话的最近状态。

计时采用协调组参与过的最早进程起点，直到最后一个参与者退出。连接恢复后重新注册最后状态和原起点。

Unix 协调目录使用 0700，套接字尽力使用 0600，Windows 使用按用户区分的命名管道。最后一个参与者退出后清除活动并关闭协调进程。

Desktop 通过 Electron Node 模式启动共享 headless 入口，Web 重启自身二进制。实现位于 `src/harness/discord-presence/`。
