# opi CLI

`opi` 调用 `@earendil-works/pi-coding-agent` 的 `main(args, { extensionFactories })`，复用上游 CLI 启动流程和 TUI，不维护启动或交互宿主副本。图形应用直接使用 SDK，约定见[前端边界](frontends.md)。

## 目录与调用方向

- `src/tui/main.ts` 注册运行环境并调用上游 `main()`，`src/tui/binary.ts` 初始化二进制资源。
- `src/harness/` 包含本项目的工具、配置、审批策略、资源和业务扩展，不引用应用入口或前端。
- `src/harness/extensions.ts` 提供 SDK 原生 `InlineExtension[]`，供各入口装配业务能力。
- `src/tui/extensions.ts` 为 CLI 装配业务扩展、工具呈现器、审批弹窗和界面增强。呈现组件只在 TUI 模式按需加载。

## 构建与运行

```bash
bun install --no-save
bun run build:tui
./dist/tui/opi
```

构建在当前系统与 CPU 架构上运行，Linux/macOS 产出 `dist/tui/opi`，Windows 产出 `dist/tui/opi.exe`。当前本地验证环境为 Linux x64。本仓库不提供预构建文件、安装脚本或二进制自更新。三端构建命令及产物见 [README](../README.md#安装使用)。

`package.json` 中的依赖跟随 `latest`，不提交锁文件或固定 Bun 版本。`trustedDependencies` 只授权所需的安装脚本。`bun run build:tui` 使用 PATH 中的 Bun。需要将产物复制到其他电脑时，建议使用官方 Bun，避免引入系统发行版特有的动态库依赖。

开发入口为 `bun src/tui/main.ts`。Bun 直接运行 TypeScript，`tsc` 只做类型检查，不再生成 Node.js 发行目录。本地 TS 模块引用统一写 `.ts` 后缀，第三方包和真实 JS 文件保留原路径。TypeScript 使用 `Preserve` / `Bundler` 模块配置，并启用 `allowImportingTsExtensions`、`verbatimModuleSyntax` 和 `noEmit`。`build` 构建三端，`build:tui` 只构建终端应用。检查使用 `typecheck`、`test` 和 `bench`。专项基准和遥测报告直接用 Bun 运行对应文件。

## 单文件与资源

产物包含代码、Bun 运行时、默认 JSONC、schema、Pi 主题与文档、PDF 字体、WASM 和当前平台所需的工具原生模块。首次启动将资源写入 `~/.pi/cache/opi/<内容哈希>/`，之后复用。写入使用临时目录和原子重命名，支持并发首次启动。缓存可删除，下次运行会重建。

执行产物不需要 Node.js、Bun 或项目的 `node_modules`。单文件不意味着静态链接所有系统库。Bash、Git、语言服务器、桌面通知后端等仍由对应功能按需使用。

编译产物不自动加载当前目录的 `.env` 或 `bunfig.toml`，避免运行行为被待处理项目改变。认证和模型等用户进程环境仍传给 Pi，内嵌资源目录由二进制入口管理。

## 保留的 Pi 行为

- 版本号、帮助、身份和上游更新提示沿用 Pi，不维护独立的 opi 版本号。
- 参数解析、认证、会话初始化、JSON/RPC 协议、交互命令和终端生命周期均复用上游实现。
- `src/harness/extensions.ts` 注册业务模块，`src/tui/extensions.ts` 装配界面。重型工具和 TUI 组件仍按需加载。
- `~/.pi/agent/` 中的认证、模型、配置、会话以及本地 Skills、提示词、主题继续使用，包括 `PI_CODING_AGENT_DIR`。
- `/reload` 重新发现外部扩展，读取修改后的入口和依赖，并重建模块状态。修改静态代码后必须重新构建并重启。
- 子代理和 Discord 协调进程复用当前可执行文件，通过 `src/harness/runtime/headless.ts` 执行，不装配 TUI 扩展。源码开发时由 Bun 运行该共享入口，不寻找系统 `pi`。

## 外部扩展

编译产物沿用 Pi 的扩展发现与加载规则：

- 自动发现 `~/.pi/agent/extensions/` 和项目 `.pi/extensions/` 中的 TS/JS 扩展，包括目录入口和 `package.json` 中的 `pi.extensions`。
- 支持全局及项目 settings 的 `extensions` 字段，以及 `-e/--extension <本地路径>`。
- 项目扩展受 Pi 的项目信任规则控制。`--approve` 信任当前项目，`--no-approve` 忽略项目资源。
- `-ne/--no-extensions` 禁用自动发现、settings 扩展和本仓库的集成模块，但仍加载显式 `-e` 和 Pi 自带内联模块。终端宿主不属于扩展，关闭扩展后仍可使用基础 TUI。

```bash
opi -e ./my-extension.ts
opi -ne -e ./my-extension.ts
```

外部扩展无需重新打包。启动或交互模式的 `/reload` 会读取扩展，不监听文件变化。扩展可导入 Pi 提供的内嵌 SDK 和 TypeBox，其他依赖需安装在扩展可解析的位置，不由 opi 自动安装。

构建仅调整 `jiti/static` 的依赖加载时机，保留上游解析、转译、虚拟模块和缓存机制。Jiti/Babel 仍内嵌于单文件中，但首次加载外部扩展时才初始化，后续重载复用转译器。无外部扩展时仍执行 Pi 的资源发现，不增加后台监听或重复扫描。直接运行 `bun src/tui/main.ts` 不经过构建适配，沿用上游加载时机。

## 不支持的行为

`install`、`remove`、`uninstall`、`update`、`list` 和 `config` 是 Pi 包管理入口，opi 不提供这些命令。上游帮助仍可能列出它们。既有 settings 中的 `packages` 不在支持范围，需由用户移除或改用不含该字段的配置目录，opi 不改写这些文件，也不适配上游的包解析与安装逻辑。

上游更新提示表示有新的 Pi 版本，不会改写当前二进制。更新源码后，执行 `rm -f bun.lock && bun install --no-save --no-cache && bun run build:tui`，重新解析最新依赖并构建。上游变更可能导致构建或测试失败，通过验证后再替换已安装的二进制。

## 验证

测试运行器暂时保留 Vitest，需要 Node.js >= 22.19.0。产品和构建使用 Bun，这个 Node.js 依赖仅用于开发测试。

```bash
bun run typecheck
bun run test
bun run test tests/cli tests/rpc
bun run test --coverage
```

`test` 和 `bench` 显式先构建 TUI，避免使用旧产物，也不触发 GUI 构建。只运行不依赖二进制的源码测试时，可用 `bun run vitest run tests/<目录>`。

SDK 测试使用原生创建接口加载业务扩展，验证无需 CLI/TUI 的文件工具回路和会话替换。CLI 测试通过本地 HTTP 模型服务驱动真实二进制，覆盖参数输出对照、文件读写、解析 worker、PDF、子代理、提示词、并发资源提取、外部扩展加载和 Linux TUI 的 `/reload`。RPC 测试覆盖状态、静态命令、Bash 事件及退出。测试不调用付费模型。

Linux 下可增加无 Node/Bun、无仓库挂载的容器验证：

```bash
OPI_CONTAINER_IMAGE=docker.io/library/eclipse-temurin:17-jdk bun run test tests/cli/container.test.ts
```

需要 Podman 和可运行该二进制的 glibc 镜像。容器只挂载临时测试目录，使用宿主网络访问本地模型服务。镜像中不得预装 Node/Bun。OAuth、真实桌面剪贴板与通知，以及其他系统的交互行为尚未实机验证。
