# opi

Orion's Pi Agent.

## 安装使用

`opi` 是具有定制工具和前端的 Pi 封装，沿用 Pi 的版本、身份和更新提示。构建需要 Bun >= 1.4.0，无需单独安装 Pi。仓库可放在任意目录。

```bash
git clone https://github.com/Orion-zhen/o-pi.git
cd o-pi
bun install --no-save
bun run build:tui
./dist/tui/opi
```

三端可独立构建，也可用 `bun run build` 一次构建全部目标：

| 目标 | 入口 / 应用名 | 构建命令 | 产物 |
| --- | --- | --- | --- |
| TUI | `opi` | `bun run build:tui` | `dist/tui/opi`，Windows 为 `opi.exe` |
| WebUI | `opi-web` | `bun run build:web` | `dist/web/opi-web`，Windows 为 `opi-web.exe` |
| Desktop | `opi-desktop` | `bun run build:desktop` | `dist/desktop/release/opi-desktop.AppImage`、`.dmg` 或 `.exe` |

TUI 和 WebUI 是包含 Bun 运行时及必需资源的单文件程序。Desktop 包含 Electron 及应用资源，不是裸单文件程序。三端互不依赖，运行产物无需另装 Node.js、Bun 或仓库中的 `node_modules`，仍需平台基础库及 Bash、Git 等实际使用的外部工具。构建面向当前系统与 CPU 架构。当前已在 Linux x64 验证，其他平台尚未实机验证。

TUI 开发使用 `bun run dev:tui`，Web 开发使用 `bun run dev:web`。项目不固定 Bun 版本或提交锁文件。构建使用 PATH 中的 Bun，制作通用分发产物时使用官方 Bun，避免引入系统发行版特有的动态库依赖。

可复用的体验配置见 [`agent/settings.example.jsonc`](agent/settings.example.jsonc)。按需合并到 `~/.pi/agent/settings.json`，不要覆盖已有 provider、model 等个人设置。运行与升级边界见 [CLI](docs/cli.md)。

## 组合技

搭配以下仓库使用效果更佳:

* [Orion-zhen/dot-agents](https://github.com/Orion-zhen/dot-agents): skill, prompt template 预设仓库.
* [Orion-zhen/o-pet](https://github.com/Orion-zhen/o-pet): 适配欧派的桌面宠物 App.

## 文档

* [CLI 入口](docs/cli.md)
* [GUI 入口](docs/gui.md)
* [前端与 SDK 约定](docs/frontends.md)
* [配置分层](docs/configuration.md)
* [自动会话标题](docs/auto-title.md)
* [性能 Benchmark](docs/benchmark.md)
* [文件工具设计](docs/file-tools/README.md)
* [Bash 工具](docs/bash-tool.md)
* [LSP 内部增强](docs/lsp.md)
* [Web 工具](docs/web-tools.md)
* [Tool Input Repair](docs/tool-repair.md)
* [Approval Gate](docs/approval-gate.md)
* [本地遥测](docs/telemetry.md)
* [Discord Rich Presence](docs/discord-presence.md)
* [o-pet 桌宠集成](docs/o-pet.md)
* [OpenAI-compatible provider](docs/openai-compatible-provider/README.md)
* [TUI V1](docs/tui.md)
* [Slash commands](docs/slash-cmds.md)
* [Skill Context](docs/skill-context.md)
* [Subagent](docs/subagent.md)
* [RPC 支持矩阵](docs/rpc.md)
* [Prompt Templates](docs/prompt-templates.md)
* [提示词设计](docs/prompt-design.md)
* [Pi 工具提示词字段](docs/tool-prompt-fields.md)
* [Token counter](docs/token-counter.md)

## 致谢

特别感谢 [lzhao013](https://github.com/lzhao013-web) 为本项目的开发和后续优化提供的优秀的测试反馈.
