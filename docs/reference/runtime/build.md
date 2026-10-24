# 构建与资源

构建入口为 `scripts/build.mjs`，需要 Bun >= 1.4.0。依赖使用 `latest`，仓库不提交锁文件。安装与升级步骤见[使用指南](../../guides/getting-started.md)。

## 目标

| 命令 | 结果 |
| --- | --- |
| `bun run build` | 构建 TUI、Web、Desktop |
| `bun run build:tui` | TUI 单文件程序 |
| `bun run build:web` | Web 单文件程序和内嵌前端 |
| `bun run build:desktop` | Electron 应用和当前平台安装包 |
| `bun run build:desktop --dir` | 只生成桌面应用目录 |
| `bun run build:gui` | 生成供源码开发使用的 `dist/gui/` |
| `bun scripts/build.mjs web desktop --dir` | 构建 Web 和桌面应用目录 |

默认构建时，每个应用只清理自己的 `dist/<应用>/`。指定 `--target` 时只清理 `dist/<平台>/<应用>/`，保留其他平台和默认构建的产物。同一次构建的 Web 和 Desktop 共用一次 Vite 构建，结束时删除临时资源。

TUI 和 Web 由 `scripts/build/bun.mjs` 编译，Desktop 由 `scripts/build/desktop.mjs` 打包。构建使用 PATH 中的 Bun，制作分发产物时建议使用官方 Bun。

## 交叉编译

`--target <平台>` 适用于三端，可选值：

| 系统 | x64 | arm64 |
| --- | --- | --- |
| Linux glibc | `linux-x64` | `linux-arm64` |
| Linux musl | `linux-x64-musl` | `linux-arm64-musl` |
| Windows | `windows-x64` | `windows-arm64` |
| macOS | `darwin-x64` | `darwin-arm64` |

```bash
bun run build:tui --target windows-x64
bun run build:web --target linux-arm64
bun run build:desktop --target windows-x64
bun run build --target darwin-arm64
```

指定 `--target` 且未指定应用时构建 TUI 和 Web，构建 Desktop 需显式指定应用。即使目标平台与本机相同，指定参数后也使用 `dist/<平台>/<应用>/` 输出目录。

TUI 和 Web 使用 Bun 原生的 `compile.target`。Windows 文件名带 `.exe`，其他平台不带扩展名。Bun 按需下载并缓存目标运行时。

Desktop 使用 electron-builder 按目标系统和架构打包：

- Linux、Windows 和 macOS 分别生成 AppImage、NSIS 安装程序 `.exe` 和 DMG，位于 `dist/<平台>/desktop/release/`。
- Linux 交叉构建 Windows 安装包需要在 PATH 中安装系统 Wine。构建脚本设置 `USE_SYSTEM_WINE=true`，不下载 Wine，不使用 Docker。不要设置覆盖系统 Wine 的 `ELECTRON_BUILDER_WINE_TOOLSET_DIR`。
- Electron 不支持 Linux musl。macOS 安装包需在 macOS 上构建，Linux 安装包需在 Linux 或 macOS 上构建。
- `--dir` 只生成目标平台的应用代码和资源到 `dist/<平台>/desktop/app/`，不包含 Electron，也不制作安装包。跨系统生成的目录不能直接用本机 Electron 运行。

`platform.mjs` 统一映射 Bun 目标和原生包后缀。跨平台时，`native.mjs` 读取当前安装的 Canvas、resvg 包声明的对应平台依赖版本，通过 `bun install --os/--cpu/--libc` 安装到临时目录，再将 `.node` 文件内嵌到产物，删除临时安装目录。安装禁用生命周期脚本，不改动仓库的 `package.json`、锁文件或 `node_modules`。目标平台与本机相同时复用已安装的原生包。

构建成功只说明生成了目标格式的程序。启动、原生模块和 worker 仍需在目标系统上验证。macOS 产物未配置开发者签名和公证。

## 内嵌资源

TUI 和 Web 包含 Bun 运行时、默认配置、schema、Pi 主题与文档、PDF 字体、WASM 和平台原生模块。首次启动提取到：

```text
~/.pi/cache/opi/<内容哈希>/
```

提取采用临时目录和原子重命名，可供并发启动复用。删除缓存后，下次启动会重建。

Desktop 包含 Electron 和应用资源，worker 与需要直接访问的原生资源按打包规则解包。

运行产物仍依赖平台基础库。Bash、Git、语言服务器和通知命令由对应功能调用。

## 启动环境

二进制入口在加载 Pi 配置模块前设置资源目录。子进程和 worker 继承该目录。编译产物关闭当前工作目录的 `.env` 和 `bunfig.toml` 自动加载，用户进程环境仍传给 Pi。

TUI 的 `main.ts` 调用上游 `main(args, { extensionFactories })`。Web 直接创建 GUI 宿主，Desktop 通过 utility process 运行后端。

## TypeScript 与测试

Bun 直接运行 TypeScript。`tsc` 只做类型检查，采用 `Preserve` / `Bundler`、`allowImportingTsExtensions`、`verbatimModuleSyntax` 和 `noEmit`。本地 TS 导入使用 `.ts` 后缀。

Vitest 需要 Node.js >= 22.19.0。检查方式见[测试](testing.md)。
