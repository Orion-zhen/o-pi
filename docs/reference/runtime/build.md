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

每个应用只清理自己的 `dist/<目标>/`。同一次构建的 Web 和 Desktop 共用一次 Vite 构建，结束时删除临时资源。

TUI 和 Web 由 `scripts/build/bun.mjs` 编译，Desktop 由 `scripts/build/desktop.mjs` 打包。构建使用 PATH 中的 Bun，制作分发产物时建议使用官方 Bun。

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
