# MCP

三端共用 Pi 原生 MCP 工厂。GUI 提供配置和认证交互，连接与调用由 SDK 管理。

## 配置

用户配置为 `~/.pi/agent/mcp.json`，路径跟随 Pi 用户目录。受信任项目可使用 `.pi/mcp.json`，同名服务覆盖全局定义。

GUI“设置 → 连接与集成 → MCP 服务”编辑用户配置。修改加入草稿，保存后新会话或 `/reload` 生效。

本地服务填写程序、逐项参数、环境变量和工作目录。“粘贴启动命令”按 POSIX 引号与转义拆分参数，不执行 Shell 展开、管道或重定向。

远程 HTTP 服务填写地址、OAuth、Bearer Token、自定义请求头或已登录提供方凭据。OAuth 高级参数和其他字段可通过表单或 JSON 编辑。

“导入配置”接受完整 `mcpServers` 或单个服务对象，预览后进入草稿。同名与规范化名称冲突需确认或改名。

## 认证

只配置可信服务。本地进程在后端电脑运行，远程服务会收到配置的认证信息。

凭据可使用 `${ENV_NAME}`，编辑阶段保留引用。`!command` 在运行时取值。表单遮蔽密钥，文件和 JSON 编辑器仍保存明文或引用。

使用提供方凭据会把该提供方的令牌发送给配置的 MCP 地址。

```text
/mcp
/mcp login
/mcp logout
/mcp reconnect
```

GUI 的 `/mcp` 打开配置页，子命令沿用 SDK。OAuth 登录受上游超时控制，关闭会话会取消登录并释放回调监听。备用输入框可以取消，授权请求准备阶段需等待 SDK 超时或关闭会话。

## 工具暴露

`exposure` 控制服务默认暴露，`toolExposure` 覆盖单工具。精确名称优先于通配规则，通配规则按顺序匹配。

| 方式 | 行为 |
| --- | --- |
| direct | 直接加载 |
| codemode、deferred | 注册延迟工具，按需发现 |
| hidden | 隐藏，无法发现和调用 |

`codemode-deferred` 是上游别名。opi 由 codemode 工具选择决定会话模式，MCP 的 `autoEnableCodemode` 不触发模式切换。

## 会话选择

GUI 工具面板提供服务总开关和单工具开关。关闭服务隐藏其专属工具，包括后续新增工具，保留单工具选择。重新开启后恢复原配置的暴露方式。

选择按会话分支保存，刷新、恢复和重载后保留。共享资源工具 `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` 有独立开关，仍可访问已关闭专属工具的服务资源。

普通模式中，未加载的可用延迟工具触发 tool_search。Codemode 使用 searchTools，见 [Codemode](../codemode/README.md)。

服务启停开关表示配置状态，实际连接由 SDK 管理。实现位于 `src/harness/extensions/mcp.ts` 和 `src/gui/ui/mcp/`。
