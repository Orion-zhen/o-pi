# 配置

## 选择配置文件

| 需要调整 | 文件或入口 |
| --- | --- |
| 默认模型、工具、压缩、重试 | `~/.pi/agent/settings.json` |
| 自定义模型服务 | `~/.pi/agent/models.json`，或 GUI 的“设置 → 模型服务” |
| 终端快捷键 | `~/.pi/agent/keybindings.json` |
| GUI 外观和交互 | GUI 设置，或 `~/.pi/agent/configs/gui.jsonc` |
| 文件工具、网页工具、审批等 | `~/.pi/agent/configs/<模块>.jsonc` |
| MCP 服务 | `~/.pi/agent/mcp.json`，或 GUI 的“设置 → 连接与集成” |

[体验配置示例](../../agent/settings.example.jsonc)可按需合并到 `settings.json`，保留自己的模型和认证设置。

Pi 原生文件和 GUI 配置支持 `PI_CODING_AGENT_DIR`。其他模块使用各自的配置路径环境变量，见[配置分层](../reference/runtime/configuration.md)。

## 添加模型服务

在 GUI 中打开“设置 → 模型服务”，添加地址、API 类型和认证，选择或手动填写模型 ID。保存后重载当前会话，再通过模型选择器使用。

也可以编辑 `models.json`：

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [{ "id": "model-id" }]
    }
  }
}
```

将地址和 ID 替换为服务实际值。示例中的 `local` 是占位密钥，适合允许此认证值的本地服务。密钥可写成环境变量引用，如 `"$MODEL_API_KEY"`。

思考参数、后缀路由和请求体配置见[模型 Reference](../reference/models/README.md)。

## 选择默认工具

TUI 输入 `/tools`，选择工具后按 `Ctrl+S` 保存全局默认值。GUI 在输入框底部打开工具选择器，再保存为默认工具。

也可以在 `settings.json` 中设置：

```json
{
  "defaultTools": ["read", "find", "grep", "ls", "write", "edit", "bash"]
}
```

显式列表替换默认集合。只写 `+name` 或 `-name` 时，在默认集合上增减。例如启用脚本调用：

```json
{ "defaultTools": ["+codemode"] }
```

工具选择控制模型可用接口。操作审批见[审批模块](../reference/approval-gate/README.md)。

## 修改模块设置

用户配置只写需要覆盖的字段。例如关闭自动标题，在 `~/.pi/agent/configs/auto-title.jsonc` 中写入：

```json
{ "enabled": false }
```

GUI 设置也可编辑这些模块。修改先保存在草稿中，点击“保存”写入配置，点击“放弃修改”撤销草稿。

生效时机取决于模块。文件工具和网页工具在后续调用读取配置，自动标题等会话组件需要新建会话或 `/reload`，Desktop Web 监听设置需要重启应用。详情见各模块 Reference。

## 项目配置

文件工具、LSP、子代理和 Discord Presence 支持 `.pi/configs/<模块>.jsonc`。项目配置叠加在用户配置之上，允许字段由模块决定。

例如为项目关闭 Discord 状态，创建 `.pi/configs/discord-presence.jsonc`：

```json
{ "enabled": false }
```

项目规则写入 `AGENTS.md`。可复用技能放在技能目录，重复任务放在提示词模板目录，见[技能](../reference/skill-context/README.md)和[模板](../reference/prompts/templates.md)。
