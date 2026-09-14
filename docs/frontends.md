# 前端与 SDK 约定

TUI 和未来 Desktop 都使用 `pi-coding-agent`，但不需要相同的启动流程。CLI 通过上游 `main()` 复用完整终端应用。Desktop 后端直接调用 SDK，绑定自己的界面，不经过 CLI 或 TUI。

## 分工

- `src/harness/` 保存本项目的工具执行、审批策略、子代理、配置和业务扩展，不引用应用入口或前端。
- `src/harness/extensions.ts` 导出 SDK 原生 `InlineExtension[]`，可通过 `createAgentSessionServices()` 的 `resourceLoaderOptions.extensionFactories` 加载。各工厂创建独立的会话状态。
- `src/tui/` 保存终端呈现与增强。`extensions.ts` 为业务扩展提供呈现器、弹窗和只读视图，再交给上游 `main()`。

不另设 Agent API、Session 门面或事件副本。会话、运行状态和消息队列以 SDK 为准。新增共享业务放入 harness，终端布局、快捷键和组件工厂留在 TUI。

## Desktop 使用的 SDK 能力

| 需求 | SDK 接口 |
| --- | --- |
| 创建会话及工作目录服务 | `createAgentSessionServices`、`createAgentSessionFromServices`、`createAgentSessionRuntime` |
| 提交、取消、排队 | `AgentSession.prompt`、`abort`、`steer`、`followUp` |
| 读取状态和订阅事件 | 会话公开状态、`subscribe`、`AgentSessionEvent` |
| 新建、恢复、分支、导入 | `AgentSessionRuntime.newSession`、`switchSession`、`fork`、`importFromJsonl` |
| 模型、思考级别、认证、配置 | `AgentSession` 对应操作及 `runtime.services` |
| 扩展用户交互 | `bindExtensions`、`ExtensionUIContext` |
| 会话替换和退出 | `setBeforeSessionInvalidate`、`setRebindSession`、取消订阅和 `dispose` |

SDK 的 runtime 工厂负责在工作目录或会话变化后重建服务。界面释放旧订阅，再绑定新会话。不复制 CLI 参数转换、会话管理、重试、压缩或队列逻辑。直接使用 SDK 加载业务扩展的验证见 [`tests/harness/extensions.test.ts`](../tests/harness/extensions.test.ts)。

## 图形界面的边界

业务可复用不等于终端交互可以直接显示。Desktop 需要适配审批、选择、输入等交互，以及各工具结果的图形呈现。保留项目信任和审批检查，不以默认批准代替交互。Discord Presence 属于共享业务，按 SDK 的 `hasUI` 和配置启用，不限定 TUI。Desktop 的协调进程打包要求见 [Discord Presence](discord-presence.md#desktop-接入)。

SDK 的文件和进程能力运行在后端。浏览器 WebUI 或隔离的桌面渲染进程需要通信桥接，可评估现有 RPC。当前不创建 Desktop 空目录，不预设图形框架或新的通信协议。
