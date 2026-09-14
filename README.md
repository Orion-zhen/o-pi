# o-pi

Orion's Pi Agent.

## 安装使用

需要 Node.js >= 22.19.0，无需单独安装 Pi。仓库可放在任意目录，已有的 `~/.pi` 克隆也可继续使用。

```bash
git clone https://github.com/Orion-zhen/o-pi.git
cd o-pi
npm install
npm run build
npm link
opi
```

`npm run build` 编译入口，`npm link` 将 `opi` 加入 npm 全局命令目录。也可不安装全局入口，直接运行 `node dist/cli.js`。修改源码后执行 `npm run build`。

`opi` 复用 Pi 的 CLI 和 TUI，静态集成本仓库的工具与界面增强。原有参数、斜杠命令和 `~/.pi/agent/` 下的个人配置、认证、资源及会话继续使用。`-ne/--no-extensions` 关闭集成功能和自动发现的扩展，显式 `-e/--extension` 仍有效。

旧的 `agent/extensions/` 已迁至 `src/extensions/`，不再由原 `pi` 自动加载。已有用户切换命令为 `opi`，不要再通过 settings 或 `-e` 重复加载本仓库入口。

可复用的体验配置见 [`agent/settings.example.jsonc`](agent/settings.example.jsonc)。按需合并到 `~/.pi/agent/settings.json`，不要覆盖已有 provider、model 等个人设置。运行与升级边界见 [CLI](docs/cli.md)。

## 组合技

搭配以下仓库使用效果更佳:

* [Orion-zhen/dot-agents](https://github.com/Orion-zhen/dot-agents): skill, prompt template 预设仓库.
* [Orion-zhen/o-pet](https://github.com/Orion-zhen/o-pet): 适配欧派的桌面宠物 App.

## 文档

* [CLI 入口](docs/cli.md)
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
