# GUI 架构

Web 与 Desktop 直接创建 Pi SDK runtime，共用 `src/gui/host/` 和 React 界面。

## 宿主与会话

| 对象 | 职责 |
| --- | --- |
| `GuiHost` | 会话索引、共享服务和资源管理 |
| `GuiSession` | 逻辑会话身份、授权和执行实例归属 |
| `GuiExecution` | 可回收的 SDK runtime、执行任务和载荷 |
| `GuiClient` | 客户端导航、订阅和操作路由 |

会话创建使用 `createAgentSessionServices`、`createAgentSessionFromServices` 和 `createAgentSessionRuntime`。提交、取消、引导与跟进分别调用 `prompt`、`abort`、`steer` 和 `followUp`。

切换页面只改变订阅。新建、分支和导入创建独立实例。GUI 另外跟踪附件读取、命令和后台命名，以这些状态判断是否可以回收。

## 扩展交互

GUI 绑定 `mode: "print"` 和真实 `uiContext`，SDK 提供 `hasUI: true`。标准确认、选择、输入和编辑接口映射为图形弹窗。终端专属的 `ctx.ui.custom()`、输入监听和组件工厂仍由 TUI 使用。

按钮发送类型化 GUI 操作，手动输入斜杠命令走 SDK 分发。工具执行与结构化结果来自 harness，呈现器由 GUI 注入。

## 连接

Desktop 通过受限 preload 桥接连接 Electron utility process。渲染进程没有 Node 权限。该后端可按 `desktopWeb` 配置同时提供 HTTP/WebSocket 服务，与窗口共用一个 `GuiHost`。

独立 Web 使用 Bun 后端。浏览器通过同源 HTTP 操作和 WebSocket 订阅连接宿主。WebSocket 分配连接标识，HTTP 请求通过 `X-Opi-Client` 关联，并用 `{ sessionId, value }` 指定目标。

连接标识用于路由，服务免登录。部署方式见[远程访问](../../guides/remote-access.md)。

绘制帧携带序号并等待确认，背压时合并状态。通知使用独立通道。重连重新建立全量基线，随后只发送变更记录和顺序变化。

## 模块组织

`src/gui/` 首先按运行边界划分：

| 目录 | 职责 |
| --- | --- |
| `shared/` | 跨端契约与共享纯逻辑，不包含 Node、DOM 或 React 执行逻辑 |
| `host/` | SDK 宿主、会话执行、文件系统与资源管理 |
| `frontend/` | 浏览器和 Electron 渲染进程共用的 React 应用 |

`shared/protocol/` 按操作、查询、状态、事件、连接、桌面桥接和增量同步拆分。消息与工具输出模型归 `shared/messages/`，配置契约归 `shared/config/`，诊断数据与校验归 `shared/diagnostics/`。仅供前端使用的会话树、消息指标和 Git 展示索引归对应业务模块，不因其是纯函数而放进共享层。

### 前端

`frontend/` 区分应用组装、基础能力和业务功能：

| 目录 | 职责 |
| --- | --- |
| `app/` | 应用组装、布局、侧栏、全局弹窗、欢迎页与更新日志 |
| `app/settings/` | 设置窗口、分类导航和编辑器组装 |
| `connection/` | 宿主连接、事件订阅、请求、查询上下文和浏览器通知 |
| `diagnostics/` | 前端异常采集、错误边界和诊断展示 |
| `forms/` | 共用配置表单、草稿注册和保存协调 |
| `ui/` | 基础控件、通用交互，以及 `motion/`、`theme/`、`content/`、`media/` 呈现能力 |
| `features/chat/` | `composer/` 输入、`transcript/` 消息流、`messages/` 消息与技能卡片、`tools/` 工具交互与结果 |
| `features/sessions/` | 会话列表、树、草稿、活动与会话设置 |
| `features/workspace/` | 工作区、文件树、Git、LSP 状态与 `preview/` 文件预览 |
| `features/models/` | 模型选择与 `services/` 模型服务配置 |
| `features/auth/` | 认证状态、浏览器授权流程与认证界面 |
| `features/preferences/` | GUI 偏好读取、编辑与应用 |
| `features/modules/` | harness 模块配置编辑器 |
| `features/mcp/`、`features/storage/`、`features/reports/` | MCP 配置、存储管理、统计与用量报告 |

设置窗口只组装编辑器。各编辑器依赖 `forms/`，不依赖设置窗口。Markdown、代码、公式和图片查看器不认识会话。消息角色、技能卡片及需要查询宿主的会话图片归聊天模块。

### 依赖与文件规则

- `shared/` 不依赖 `host/` 或 `frontend/`，包括类型引用。宿主与前端不互相导入实现，通过共享契约通信。
- `app/` 组合功能，`features/` 不引用 `app/`。同时组合会话、文件预览和报告的侧栏属于应用层。
- `ui/` 不引用业务模块或连接模块。`forms/` 不引用具体编辑器或应用导航。组件就近声明所需属性，不依赖应用状态总类型。
- 功能之间允许明确、单向的复用。共享会话草稿、模型选择器等能力保留在所属功能，不统一提升到公共层。
- 组件、Hook、逻辑和样式按功能就近放置，不另建全局 `hooks/`、`types/` 或 `utils/`。不强制为目录添加 `index.ts`。
- `@/` 指向 `frontend/`。跨前端模块使用别名，模块内部使用相对路径。跨端代码使用相对路径。

语义配色由 `frontend/ui/theme/palette.ts` 生成，变量映射位于 `frontend/ui/theme/theme.css`。Vite、Vitest、TypeScript 和 `components.json` 的前端路径保持一致。

## 模型上下文

请求上下文通过 `buildSessionProjection()` 读取，应用 `context_edit`。聊天历史通过 `buildContextEntries()` 读取原始条目。

虚拟模型路由交给 SDK。选择器保留所选模型，并展示 `AgentSession.routedModel` 的最近成功响应模型与思考级别。图片生成和分类属于独立模型类型，通过 Codemode 的原生 `models` API 使用。

测试方法见[运行时测试](../runtime/testing.md)。
