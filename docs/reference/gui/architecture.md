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

## 前端目录

`src/gui/ui/` 按功能组织组件、Hook 和样式：

| 目录 | 职责 |
| --- | --- |
| `app/` | 应用组装、布局、弹窗、欢迎页与更新日志 |
| `runtime/` | 宿主连接、事件、查询和认证 |
| `composer/` | 输入、历史、建议和附件 |
| `sessions/` | 列表、树、草稿、活动与信息栏 |
| `transcript/` | 消息流、回复阶段和滚动 |
| `tools/` | 选择、审批和结果展示 |
| `workspace/` | 工作区、文件树、Git 与预览 |
| `preferences/` | GUI 偏好、主题、字体与材质 |
| `settings/` | 设置导航、保存协调、公共表单和模块设置 |
| `models/`、`model-services/` | 模型选择与服务配置 |
| `mcp/` | MCP 配置 |
| `storage/` | 存储管理 |
| `reports/` | 统计、用量与遥测 |
| `content/` | Markdown、代码、公式和技能卡片 |
| `components/`、`lib/` | 共用组件与逻辑 |

业务样式与组件放在同一功能目录。语义配色由 `preferences/palette.ts` 生成，变量映射位于 `preferences/theme.css`。

## 模型上下文

请求上下文通过 `buildSessionProjection()` 读取，应用 `context_edit`。聊天历史通过 `buildContextEntries()` 读取原始条目。

虚拟模型路由交给 SDK。选择器保留所选模型，并展示 `AgentSession.routedModel` 的最近成功响应模型与思考级别。图片生成和分类属于独立模型类型，通过 Codemode 的原生 `models` API 使用。

测试方法见[运行时测试](../runtime/testing.md)。
