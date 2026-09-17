# o-pi

Orion's Pi Agent.

## 安装使用

本仓库不提供预构建文件，TUI、WebUI 和 Desktop 均需用户从源码自行编译。

`opi` 是具有定制工具和前端的 Pi 封装，沿用 Pi 的版本、身份和更新提示。构建需要 Bun >= 1.4.0，无需单独安装 Pi。仓库可放在任意目录。

```bash
git clone https://github.com/Orion-zhen/o-pi.git
cd o-pi
bun install --no-save
bun run build:tui
./dist/tui/opi
```

三端可独立构建，也可用 `bun run build` 一次构建全部目标：

| 目标 | 构建命令 | 产物 |
| --- | --- | --- |
| TUI | `bun run build:tui` | `dist/tui/opi`，Windows 为 `opi.exe` |
| WebUI | `bun run build:web` | `dist/web/opi-web`，Windows 为 `opi-web.exe` |
| Desktop | `bun run build:desktop` | `dist/desktop/release/` 下的 AppImage、DMG 或安装 EXE |

TUI 和 WebUI 是包含 Bun 运行时及必需资源的单文件程序。Desktop 包含 Electron 及应用资源，不是裸单文件程序。三端互不依赖，运行产物无需另装 Node.js、Bun 或仓库中的 `node_modules`，仍需平台基础库及 Bash、Git 等实际使用的外部工具。构建面向当前系统与 CPU 架构。当前已在 Linux x64 验证，其他平台尚未实机验证。

TUI 开发使用 `bun run dev:tui`，Web 开发使用 `bun run dev:web`。项目不固定 Bun 版本或提交锁文件。构建使用 PATH 中的 Bun，制作通用分发产物时使用官方 Bun，避免引入系统发行版特有的动态库依赖。

`opi` 调用 `pi-coding-agent.main()`，复用上游 CLI、会话初始化和 TUI。`src/harness/` 保存本项目的业务扩展，三端入口分别为 `src/tui/main.ts`、`src/web/main.ts` 和 `src/desktop/main.ts`，`src/tui/` 同时保存终端呈现与增强。Desktop 和 `opi-web` 直接使用 SDK 和业务扩展，共用 React 界面，不经过 CLI、TUI 或 Pi stdio RPC。`~/.pi/agent/` 下的个人配置、认证、本地资源及会话继续使用。支持 Pi 的外部 TS/JS 扩展发现、`-e/--extension` 和 `/reload`，无外部扩展时不初始化 Jiti/Babel。`-ne/--no-extensions` 关闭本仓库的集成功能和外部扩展自动加载，但保留显式 `-e`。不支持 Pi 包管理命令。

本仓库模块位于 `src/harness/extensions/`，界面装配位于 `src/tui/extensions.ts`，不再由原 `pi` 自动加载。已有用户切换命令为 `opi`，不要再通过 settings 或 `-e` 重复加载本仓库入口。

可复用的体验配置见 [`agent/settings.example.jsonc`](agent/settings.example.jsonc)。按需合并到 `~/.pi/agent/settings.json`，不要覆盖已有 provider、model 等个人设置。运行与升级边界见 [CLI](docs/cli.md)。

## GUI MVP

```bash
# 独立网页版，打开终端打印的完整链接
bun run build:web
./dist/web/opi-web --cwd /path/to/project

# 桌面预览
bun run build:desktop --dir
bun run desktop

# 当前平台的桌面分发包
bun run build:desktop
```

GUI 沿用 `~/.pi`，提供真实会话、工具、审批、模型认证、会话树和业务面板。Web 默认监听 `0.0.0.0:3141`，免登录，仅用于可信局域网。只在本机使用时加 `--host 127.0.0.1`。桌面产物在 `dist/desktop/release/`，MVP 尚未签名。功能边界、手机访问和验证方法见 [GUI MVP](docs/gui.md)。

## 组合技

搭配以下仓库使用效果更佳:

* [Orion-zhen/dot-agents](https://github.com/Orion-zhen/dot-agents): skill, prompt template 预设仓库.
* [Orion-zhen/o-pet](https://github.com/Orion-zhen/o-pet): 适配欧派的桌面宠物 App.

## 文档

* [CLI 入口](docs/cli.md)
* [GUI MVP](docs/gui.md)
* [前端与 SDK 约定](docs/frontends.md)
* [配置分层](docs/configuration.md)
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
