# GUI 架构

Web 与 Desktop 直接创建 Pi SDK runtime，共用 `src/gui/host/` 和 React 界面。

## 宿主与会话

| 对象 | 职责 |
| --- | --- |
| `GuiHost` | 会话索引、共享服务和资源管理 |
| `GuiSession` | 逻辑会话身份、授权和执行实例归属 |
| `GuiExecutionContext` | 启动与执行共用的审批、取消和客户端交互通道 |
| `GuiExecution` | 装配完成后创建的 SDK 执行实例、任务和载荷 |
| `GuiClient` | 客户端导航、订阅和操作路由 |

会话创建使用 `createAgentSessionServices`、`createAgentSessionFromServices` 和 `createAgentSessionRuntime`。提交、取消、引导与跟进分别调用 `prompt`、`abort`、`steer` 和 `followUp`。模型重载在 SDK 的 `beforeSessionStart` 中刷新目录与当前模型，扩展的 `session_start` 处理器读取更新后的状态。

切换页面只改变订阅。新建、分支和导入创建独立实例。GUI 另外跟踪附件读取、命令和后台命名，以这些状态判断是否可以回收。

`GuiSession` 区分未加载、启动、就绪和关闭阶段。启动阶段直接处理审批、取消与清通知，不等待启动任务。未加载或释放中的会话不会为控制操作创建执行实例。SDK 完成扩展加载后，装配边界确认必需的工具控制器，再创建就绪执行实例。控制器和 MCP 绑定通过可变引用接收重载更新，不另建异步握手。MCP 可以显式禁用，不属于初始化未完成。

操作类型按全局、工作区、会话导航和会话执行划分。`GuiClient` 在请求入口解析目标会话，内部导航方法必须接收确定的会话对象，不回退到当前选择。草稿直接写入客户端状态，文件补全使用目标会话的工作目录读取文件系统，两者都不加载或占用 SDK 执行资源。

### 会话搜索

搜索交互归 `frontend/features/sessions/`，协议定义启动查询、继续拉取和取消操作。每个 `GuiClient` 只持有当前搜索任务，新搜索替换旧搜索。`GuiHost` 中的搜索服务共享文件并发预算。搜索结果通过查询返回，不写入会话快照或向其他客户端广播。

`host/catalog/session-search.ts` 组织候选和扫描，`session-reader.ts` 封装流式 JSONL 读取，`search-matcher.ts` 在有界文本窗口中查找关键词，保留 Unicode 码点边界和原文高亮区间。目录摘要复用读取器，只缓存列表元数据。搜索消费最近的目录快照，不为每次输入重新刷新目录。

## 扩展交互

GUI 绑定 `mode: "print"` 和真实 `uiContext`，SDK 提供 `hasUI: true`。标准确认、选择、输入和编辑接口映射为图形弹窗。终端专属的 `ctx.ui.custom()`、输入监听和组件工厂仍由 TUI 使用。

按钮发送类型化 GUI 操作，手动输入斜杠命令走 SDK 分发。工具执行与结构化结果来自 harness，呈现器由 GUI 注入。终端状态栏和文本 Widget 的 setter 不维护 GUI 影子状态，终端组件工厂仍明确报错。

工具结果在宿主投影时按展示所需字段校验，生成带 `view` 的判别联合、摘要和错误信息。不能识别的详情保留原始正文，不进入富展示。大结果的完整投影按需读取，首屏只携带短预览。原始数据检查器排除 GUI 展示元数据。

对话框使用判别联合。选择框持有带标签的选项值，确认框持有正文，输入框持有初始值和占位符，Bash 审批持有结构化审批内容。宿主接收对应对象，不通过空参数补齐其他类型的字段。响应值、过期对话框和重复消费在宿主边界校验。

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

`app/use-gui.ts` 按会话、导航、编辑器、面板、配置、连接和认证组织应用接口，不同时扁平展开和嵌套返回同一组属性。`use-editor.ts` 管理草稿交互和文件引用，`use-session-commands.ts` 绑定会话操作与认证交互，统一通过 `send` 发送并保留操作返回值。各区域声明自己的依赖。

`app/use-host-state.ts` 在事件入口维护当前会话及其快照、草稿、对话框和报告。`features/sessions/session-state.ts` 区分加载和就绪状态，消息区与输入区只接收完整的就绪会话。会话操作绑定目标 ID，全局历史与工作区导航通过 `GlobalSend` 发送，不附带当前会话 ID。草稿和阅读位置留在 `SessionViews`，不随组件卸载清空。

`connection/use-operation.ts` 持有单次操作的空闲、处理中、成功或失败状态，阻止同一操作重复提交。组件读取派生状态，不单独维护处理中标记和错误收尾。卸载使结果回调失效，但不取消已提交的后台任务。成功回调中的程序错误交给全局诊断，不转成请求失败。

`connection/latest-request.ts` 集中管理最新读取的发布与失效，供普通读取、输入补全和分页搜索使用。搜索保留分页与后端任务释放职责。工作区状态按 `cwd` 独立创建，同一路径的合并刷新继续由 `WorkspaceState` 串行调度，不与最新请求策略混用。

模块配置查询返回同一份校验 schema，前端从中提取字段类型、枚举和约束。源码先校验，非法源码不能切回表单。控件直接按 schema 和界面元数据渲染，不再转换成另一套控件模型，也不从当前值猜测控件类型。表单的编辑中间态可以保留，但无效草稿不能保存。

配置加载成功后才挂载草稿编辑器。编辑器提交 `clean`、`invalid` 或携带保存函数的 `ready` 计划，不再分别注册脏标记、有效性和可空保存函数。设置协调器从计划计算页面标记与保存可用性，执行时读取最新命令。保存按文件顺序执行，失败项保留草稿，其余项继续提交。关闭后不再发起后续写入。

MCP 源码保留原文，解析结果区分已解析和无效，重复键草稿另标为不可序列化。解析成功不等于字段校验通过，只有字段校验通过且可序列化的修改才产生保存计划。源码编辑器通过新建 CodeMirror `EditorState` 应用外部重置，同时清除撤销历史。

会话折叠记忆通过 `useSyncExternalStore` 订阅，不复制为组件本地状态。默认值在订阅时写入，渲染过程只读取。

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
