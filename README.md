# o-pi

Orion's Pi Agent.

## 安装使用

首先确保系统中安装了 [Pi](https://github.com/earendil-works/pi).

克隆到 Pi 配置路径:

```bash
git clone https://github.com/Orion-zhen/o-pi.git ~/.pi
```

安装依赖:

```bash
cd ~/.pi && npm install
```

可复用的 Pi 体验配置见 [`agent/settings.example.jsonc`](agent/settings.example.jsonc)。按需将其中字段合并到本机 `agent/settings.json`；provider、model、thinking level 和模型轮换列表等个人设置不包含在示例中。

## 组合技

搭配以下仓库使用效果更佳:

* [Orion-zhen/dot-agents](https://github.com/Orion-zhen/dot-agents): skill, prompt template 预设仓库.
* [Orion-zhen/o-pet](https://github.com/Orion-zhen/o-pet): 适配欧派的桌面宠物 App.

## 文档

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
