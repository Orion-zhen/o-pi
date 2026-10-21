# 运行时

opi 通过 Pi SDK 提供 TUI、Web 和 Desktop。工具与业务扩展位于 `src/harness/`，三个应用分别装配自己的界面。

## 启动与依赖

| 目录 | 职责 |
| --- | --- |
| `src/harness/` | 工具、配置、审批、技能、子代理和共享业务 |
| `src/tui/` | 调用 Pi `main()`，装配终端界面 |
| `src/gui/` | 共享 React 界面、SDK 会话宿主和通信契约 |
| `src/web/` | HTTP、WebSocket 和静态资源 |
| `src/desktop/` | Electron 窗口、preload 和后台进程 |

`src/harness/extensions.ts` 导出原生 `InlineExtension[]`。SDK 通过 `resourceLoaderOptions.extensionFactories` 加载，每个工厂创建会话状态。TUI 用 `src/tui/extensions.ts` 注入工具呈现器和界面。

子代理和 Discord 协调进程使用 `src/harness/runtime/headless.ts`。单文件程序重启自身，Desktop 使用 Electron 的 Node 模式，源码开发由 Bun 运行共享入口。

会话、消息队列、重试、压缩、模型调用和工具执行由 SDK 管理。GUI 的实例与连接管理见 [GUI 架构](../gui/architecture.md)。

## 外部扩展

CLI 沿用 Pi 的扩展发现规则：

- 全局 `~/.pi/agent/extensions/`。
- 受信任项目的 `.pi/extensions/`。
- settings 中的 `extensions`。
- `-e/--extension <本地路径>`。

支持 TS、JS、目录入口和 `package.json` 的 `pi.extensions`。项目资源受 Pi 项目信任控制，`--approve` 信任当前项目，`--no-approve` 忽略项目资源。

```bash
opi -e ./my-extension.ts
opi -ne -e ./my-extension.ts
```

`-ne/--no-extensions` 禁用自动发现、settings 扩展、本仓库集成模块和 Pi 内置扩展，保留显式 `-e`。可以通过 `-e builtin:codemode` 单独加载内置扩展。

外部扩展由内嵌 Jiti/Babel 延迟加载，可导入内嵌 Pi SDK 和 TypeBox。其他依赖需安装在扩展可以解析的位置。

`/reload` 重新读取外部扩展和资源并重建状态。静态集成代码修改后需要重新构建和启动。

## 工具注册

`src/harness/register-tool.ts` 组合工具定义、参数修复和遥测投影。执行结果同时提供模型可见的 `content` 和宿主使用的 `details`，支持结构化返回的工具还声明 `outputSchema`。

工具呈现器由各前端装配。JSON、print 和 RPC 入口按各自协议返回结果。

## 专题

- [配置分层与工具选择](configuration.md)
- [构建与资源](build.md)
- [RPC](rpc.md)
- [系统通知](notifications.md)
- [参数修复](tool-repair.md)
- [测试](testing.md)
- [性能基准](benchmark.md)
