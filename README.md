# o-pi

Orion's Pi Agent.

## 安装使用

首先确保系统中安装了 [Pi](https://github.com/earendil-works/pi).

克隆到 Pi 配置路径:

```bash
git clone https://github.com/Orion-zhen/o-pi.git ~/.pi
```

安装依赖(不包含 Tree-sitter 相关包):

```bash
cd ~/.pi && npm install
```

安装全部依赖:

```bash
cd ~/.pi && npm install --include=optional
```

## 文档

* [性能 Benchmark](docs/benchmark.md)
* [文件工具设计](docs/file-tools/README.md)
* [Bash 工具](docs/bash-tool.md)
* [LSP 内部增强](docs/lsp.md)
* [Web 工具](docs/web-tools.md)
* [Tool Input Repair](docs/tool-repair.md)
* [Approval Gate](docs/approval-gate.md)
* [本地遥测](docs/telemetry.md)
* [OpenAI-compatible provider](docs/openai-compatible-provider/README.md)
* [TUI V1](docs/tui.md)
* [Slash commands](docs/slash-cmds.md)
* [Skill Context](docs/skill-context.md)
* [Subagent](docs/subagent.md)
* [Prompt Templates](docs/prompt-templates.md)
* [提示词设计](docs/prompt-design.md)
* [Pi 工具提示词字段](docs/tool-prompt-fields.md)
* [Token counter](docs/token-counter.md)
* [Repo Map](docs/repo-map/README.md)
