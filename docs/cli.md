# opi CLI

`opi` 使用 `@earendil-works/pi-coding-agent@0.85.1` 的公开 `main(args, { extensionFactories })`，不复制参数解析器、交互模式或 RPC 协议。第一阶段继续使用 Pi TUI 和现有 o-pi 界面增强。

## 构建与运行

```bash
npm install
npm run build
npm link
opi
```

`prepare` 会尝试自动构建，但 npm 的脚本授权策略可能阻止它，因此安装步骤显式执行 `npm run build`。修改源码后也需重新构建。不安装全局命令时使用 `node dist/cli.js`。npm 全局命令目录必须在 `PATH` 中。

全局目录不可写时，可使用用户目录，无需 sudo：

```bash
NPM_CONFIG_PREFIX="$HOME/.local" npm link
export PATH="$HOME/.local/bin:$PATH"
```

安装目录不必是 `~/.pi`。默认 JSONC 和 schema 从安装目录的 `agent/defaults/`、`agent/schemas/` 读取，用户数据继续保存在原配置位置。包文件列表不包含认证、Cookie、用户配置或会话。

## 与 Pi 的关系

- `src/cli.ts` 设置 CLI 进程环境，将原始参数交给 Pi `main()`。进程标题为 `opi`，保留 `PI_CODING_AGENT=true` 和 `AI_AGENT=pi`。
- `src/extensions.ts` 显式导入并注册 20 个模块，顺序与原扩展目录一致。模块状态仍在每次会话初始化时创建。
- `src/extensions/` 保存 Pi 适配器，不是自动发现目录。普通工具、配置和业务服务继续位于各自功能目录。
- TypeScript 编译为 `dist/` 中的原生 ESM。内置模块不通过 Jiti 发现或加载，重型功能仍按需导入。
- `/reload` 仍重建资源并重新调用模块工厂。静态代码更新需要构建并重启进程，不热替换已加载的模块。
- 外部扩展、Skills、提示词、主题、项目授权和 Pi package 命令继续由上游处理。外部 TypeScript 扩展仍使用 Pi 自身的加载器。
- `-ne/--no-extensions` 关闭 o-pi 集成和自动加载的外部扩展，不阻止显式 `-e/--extension`。Pi 自带的内联模块按上游行为保留。
- `--help`、`--version`、错误提示和会话恢复提示沿用上游内容，因此部分文本仍称 `pi`，版本输出是 Pi SDK 版本。
- 子代理复用当前 CLI 脚本，在 `opi` 中启动 `opi --mode json`，沿用原工具限制、进程隔离、取消和超时策略。

## 配置与迁移

已有 `~/.pi` 用户执行构建和 `npm link` 后改用 `opi`。`agent/extensions/` 已迁至 `src/extensions/`，不要再将这些入口添加到 `settings.json` 的 `extensions` 或 `-e`，否则会重复注册。

Pi 的 `settings.json`、认证、模型、会话及资源路径规则保持不变，包括 `PI_CODING_AGENT_DIR`。o-pi 的 JSONC 覆盖路径与各模块 `PI_*` 环境变量仍按[配置分层](configuration.md)处理。Cookie 默认从 `~/.pi/agent/cookies.txt` 读取，`PI_WEB_TOOLS_COOKIES` 可覆盖。

## 升级

o-pi 使用的四个 Pi 包锁定在同一版本，避免 CLI、Agent、模型 API 和 TUI 发生版本错配。升级 o-pi 源码后执行 `npm install && npm run build`。

`opi update` 原样执行 Pi 的更新命令，更新目标仍是上游 Pi，而不是本仓库。更新 o-pi 使用 Git 和 npm。升级 Pi SDK 时需一起调整四个版本，并验证 CLI、会话、工具和依赖 Pi 私有实现的界面补丁。

## 验证

```bash
npm run typecheck
npm test -- tests/cli tests/architecture tests/rpc
npm test
```

CLI 测试使用离线模型，实际运行编译后的入口，覆盖参数与错误输出对照、JSON 工具回路、文件读写、解析 worker、Bash、审批、子代理、提示词、RPC 会话恢复，以及 Linux 伪终端中的自定义编辑器安装。测试不调用付费模型。OAuth 登录、联网更新和真实终端的人工操作未由这些自动化测试覆盖。

调研发现上游 0.85.1 的原生 provider 注册与默认模型认证快照存在竞态，直接调用 SDK 也可能在初始化完成时暂时得到空的可用模型列表。此阶段不改写上游模型选择逻辑。CLI 离线测试使用带显式认证的测试 provider，真实 provider 的该问题仍需由上游修复。
