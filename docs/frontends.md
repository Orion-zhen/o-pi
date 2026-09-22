# 前端与 SDK 约定

TUI、Desktop 和 WebUI 都使用 `pi-coding-agent`，但不需要相同的启动流程。TUI 通过上游 `main()` 复用完整终端应用。Desktop 与 Web 后端直接调用 SDK，绑定共用的 React 界面，不经过 CLI、TUI 或 Pi stdio RPC。运行方法见 [GUI MVP](gui.md)。

## 分工

- `src/harness/` 保存本项目的工具执行、审批策略、子代理、配置和业务扩展，不引用应用入口或前端。
- `src/harness/extensions.ts` 导出 SDK 原生 `InlineExtension[]`，可通过 `createAgentSessionServices()` 的 `resourceLoaderOptions.extensionFactories` 加载。各工厂创建独立的会话状态。
- 三端入口平级：`src/tui/main.ts`、`src/web/main.ts` 和 `src/desktop/main.ts`。TUI 和 Web 的 `binary.ts` 仅负责单文件启动适配，共享资源初始化位于 `src/harness/runtime/binary.ts`。
- `src/tui/` 保存终端入口、呈现与增强。`extensions.ts` 为业务扩展提供呈现器、弹窗和只读视图，再交给上游 `main()`。
- `src/gui/` 保存共享图形界面与 SDK 装配，`src/desktop/` 和 `src/web/` 分别负责 Electron 与网络宿主。输入历史位于 `src/harness/user-history.ts`，由三个前端共用。

子代理与 Discord 协调进程统一使用 `src/harness/runtime/headless.ts`。子代理复用上游 CLI JSON 流程，只加载 `src/harness/extensions.ts`，不引用任何应用入口。Bun 产物重启自身，Desktop 使用 Electron 的 Node 模式，源码开发由 Bun 运行共享入口。

## 本地构建

`scripts/build.mjs` 统一选择 `tui`、`web`、`desktop` 目标，默认构建全部。`scripts/build/bun.mjs` 编译 TUI 和 Web 单文件程序，`scripts/build/desktop.mjs` 构建 Electron 应用及平台安装包。两者共用资源收集和依赖适配。

每个目标只清理自己的 `dist/<目标>/`。同一次构建中，Web 与 Desktop 共用一次 Vite 构建，临时资源在构建结束后删除。`bun scripts/build.mjs web desktop --dir` 同时构建 Web 和桌面预览目录，不制作桌面安装包。`build:gui` 只为 Web 源码开发生成 `dist/gui/`，不属于独立应用目标。

本仓库只提供源码，不运行 GitHub Actions 或发布预构建文件。命令与产物位置见 [README](../README.md#安装使用)。

## SDK 边界

会话内容、运行状态和消息队列以 SDK 为准，不复制 Agent 执行逻辑。GUI 的 `GuiHost` 管理实例、索引和共享资源，`GuiSession` 持有单个 SDK runtime，`GuiClient` 管理客户端的查看位置和操作路由。新增共享业务放入 harness，终端布局、快捷键和组件工厂留在 TUI。

模型上下文通过 `buildSessionProjection()` 读取，包含 `context_edit` 的删除和替换。GUI 聊天历史从 `buildContextEntries()` 中的原始条目生成，不用 `session.messages` 代替历史，因此上下文编辑不改变已展示的回复。上下文用量继续由 SDK 提供，会话树隐藏 `context_edit` 元数据节点。

## Desktop 使用的 SDK 能力

| 需求 | SDK 接口 |
| --- | --- |
| 创建会话及工作目录服务 | `createAgentSessionServices`、`createAgentSessionFromServices`、`createAgentSessionRuntime` |
| 提交、取消、排队 | `AgentSession.prompt`、`abort`、`steer`、`followUp` |
| 读取状态和订阅事件 | 会话公开状态、`subscribe`、`AgentSessionEvent` |
| 新建、恢复、分支、导入 | `SessionManager.create`、`open`、`createBranchedSession`、`parseSessionEntries`，为目标会话创建独立 runtime |
| 模型、思考级别、认证、配置 | `AgentSession` 对应操作及 `runtime.services` |
| 扩展用户交互 | `bindExtensions`、`ExtensionUIContext` |
| 切换和退出 | 切换客户端订阅，取消任务、取消订阅和 `dispose` |

`GuiHost` 管理共享服务和会话目录，`GuiClient` 管理导航与订阅，长期登记的 `GuiSession` 持有身份和授权，并管理可整体释放重建的 `GuiExecution`。每个运行实例绑定一个逻辑会话及工作目录。页面切换只改变订阅，不调用 runtime 的替换方法去销毁原会话。新建和分支创建独立实例，导入分配新会话标识，避免与源会话产生双写。GUI 的持久审批规则共享写入队列，临时授权按逻辑会话隔离。共享 LSP 在宿主退出时统一释放，不随单个实例回收而重置。不复制 CLI 参数转换、重试、压缩或消息队列逻辑。直接使用 SDK 加载业务扩展的验证见 [`tests/harness/extensions.test.ts`](../tests/harness/extensions.test.ts)。

## 图形界面的边界

业务可复用不等于终端交互可以直接显示。GUI 通过真实 `ExtensionUIContext` 适配审批、选择、输入等交互，工具结果使用图形呈现。保留项目信任和审批检查，不以默认批准代替交互。Discord Presence 属于共享业务，按 SDK 的 `hasUI` 和配置启用，不限定 TUI。Desktop 的协调进程打包要求见 [Discord Presence](discord-presence.md#desktop-接入)。

SDK 的文件和进程能力运行在后端。Desktop 使用受限 preload 桥接连接 Electron utility process。Web 使用同源 HTTP 操作和 WebSocket 订阅连接 Bun 后端。WebSocket 分配连接标识，HTTP 请求通过 `X-Opi-Client` 关联连接，并用 `{ sessionId, value }` 明确操作或查询的目标。连接标识不是身份认证，服务仍免登录，仅用于可信局域网。两者均直接集成正式 SDK，当前不依赖实验性 `pi-server`、`pi-client`。
