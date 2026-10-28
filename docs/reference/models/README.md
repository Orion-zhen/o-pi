# 模型

模型、认证和思考等级由 Pi SDK 管理。GUI 提供模型选择与服务编辑，TUI 使用 `/model`、`/thinking`、`/scoped-models` 和 `/login`。

## 自定义服务

服务配置使用 `~/.pi/agent/models.json`。所有服务沿用 SDK 原生配置、认证和 API 分派，opi 补充会话请求参数调整、默认思考等级和候选模型查询。支持 Pi 已注册的 API，不限于 OpenAI。

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

GUI“设置 → 模型服务”可以编辑同一文件。候选查询按 API 自动选择地址、认证和分页方式，选中添加后保存，重载当前会话生效。

| API | 列表查询 |
| --- | --- |
| OpenAI Chat Completions、Responses、Mistral | `<baseUrl>/models` |
| Anthropic Messages | `<baseUrl>/v1/models`，已有 `/v1` 时不重复添加 |
| Google Gemini | `<baseUrl>/models`，地址须包含版本路径，例如 `/v1beta` |
| 其他协议或混合连接 | 当前会话的 Pi SDK 模型目录，不触发刷新 |

Google 候选过滤不支持 `generateContent` 的模型，并移除资源名的 `models/` 前缀。其他模型 ID 原样保留。

进入模型服务页后，各服务使用当前会话已加载的配置检测连接。点击状态标记可重新检测，悬浮查看耗时、检测时间或失败原因，不定时轮询或发送生成请求。“已连接”仅表示最近一次成功读取模型列表，不保证具体模型能生成或余额充足。仅能读取 SDK 目录时显示“SDK 目录”，不将其视为连接验证成功。没有列表接口或目录的服务显示“无法验证”，仍可手动添加模型。

未选择会话时显示“未检测”。修改地址、认证等连接配置后显示“待保存”，保存后需重载当前会话，再检测新配置。

- [配置与认证](configuration.md)
- [思考传递方式](thinking.md)
- [请求体处理](payload.md)
- [示例](examples.md)
- [排障](troubleshooting.md)

仓库示例见 [`models.example.jsonc`](../../../agent/models.example.jsonc)。

## 思考与虚拟模型

`thinking-preferences` 在当前分支内按模型记忆思考等级。切回模型时恢复该分支的选择。

扩展可通过 `registerVirtualModel()` 注册路由。SDK 保存所选模型和路由状态，界面显示最近成功响应的实际模型与思考等级。费用使用实际响应和 SDK 汇总用量。

图片生成与分类属于独立模型类型，通过 Codemode 的 `models` API 调用。

## 请求档位

```text
/codex-speed normal|fast|ultrafast
```

适用于 `openai` 和 `openai-codex`。选择保存在当前会话分支，恢复与分支切换时同步。

| 档位 | 请求 |
| --- | --- |
| normal | OpenAI 设置 `service_tier: "default"`，Codex 省略字段 |
| fast | `service_tier: "priority"` |
| ultrafast | `service_tier: "ultrafast"` |

加速可能增加费用或套餐消耗，可用性取决于模型和账号。界面显示请求档位，实际服务由提供方决定。

实现位于 `src/harness/model-services/`、`thinking-level/` 和 `codex-speed/`。
