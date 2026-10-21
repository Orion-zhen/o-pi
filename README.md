# opi

Orion's Pi Agent.

基于 Pi SDK 的编码代理，以精简上下文和专用工具，提升 Pi 编码代理的 Token 效率。

## 快速开始

构建需要 Bun >= 1.4.0。

```bash
git clone https://github.com/Orion-zhen/o-pi.git
cd o-pi
bun install --no-save
bun run build:tui # 本命令构建 TUI 软件
./dist/tui/opi
```

| 应用 | 构建命令 | 产物 |
| --- | --- | --- |
| TUI | `bun run build:tui` | `dist/tui/opi`，Windows 为 `opi.exe` |
| Web | `bun run build:web` | `dist/web/opi-web`，Windows 为 `opi-web.exe` |
| Desktop | `bun run build:desktop` | `dist/desktop/release/` 下的平台安装包 |

配置和会话沿用 `~/.pi/agent/`。完整步骤见[安装与启动](docs/guides/getting-started.md)。

## 文档

- [用户使用指南](docs/README.md#用户使用指南)：安装、配置、TUI、GUI、远程访问和排障。
- [Reference](docs/reference/README.md)：按模块查询配置、接口、行为和实现机制。

## 搭配使用

- [dot-agents](https://github.com/Orion-zhen/dot-agents)：技能与提示词模板。
- [o-pet](https://github.com/Orion-zhen/o-pet)：桌面宠物。

## 致谢

感谢 [lzhao013](https://github.com/lzhao013-web) 提供测试反馈、想法讨论和代码贡献。
