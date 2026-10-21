# 模型

模型、认证和思考等级由 Pi SDK 管理。GUI 提供模型选择与服务编辑，TUI 使用 `/model`、`/thinking`、`/scoped-models` 和 `/login`。

## 自定义服务

服务配置使用 `~/.pi/agent/models.json`。普通静态服务由 SDK 加载，opi 扩展支持思考格式转换、模型后缀路由和请求参数调整。

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

GUI“设置 → 模型服务”可以编辑同一文件。候选模型通过 `GET <baseUrl>/models` 获取，选中添加后保存，重载当前会话生效。

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

实现位于 `src/harness/openai-compatible-provider/`、`thinking-level/` 和 `codex-speed/`。
