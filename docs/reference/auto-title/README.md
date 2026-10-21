# 自动标题

新会话接受首条用户请求后，后台扩展发起独立命名请求。TUI、Web 和 Desktop 共用该扩展。

## 配置

默认文件为 [`auto-title.jsonc`](../../../agent/defaults/auto-title.jsonc)，用户文件为 `~/.pi/agent/configs/auto-title.jsonc`，可通过 `PI_AUTO_TITLE_CONFIG` 重定向。修改后新建会话或 `/reload` 生效。

```json
{
  "enabled": true,
  "model": "your-provider/your-small-model",
  "system_prompt": "概括用户请求的主要任务，用用户的语言只输出一行简短标题，最多 50 个字符。"
}
```

`model: null` 使用当前模型。字符串按第一个 `/` 分隔提供方与模型 ID，后续斜杠属于模型 ID。指定模型不可用时报告命名失败。

## 请求与结果

请求包含独立系统提示词和首条用户文本，最多 2000 个 Unicode 字符。使用模型支持的最低思考等级，输出上限 1024 tokens，30 秒超时。

标题清理控制字符、引号和空白后最多保留 50 个 Unicode 字符，通过 SDK 会话名称接口保存。

每个新会话尝试一次。已有名称、已有用户消息的历史会话、子代理和扩展注入的运行跳过命名。

手动改名、关闭、替换和重载会话时取消旧请求，过期结果丢弃。失败保留原名称并通知用户，主任务继续运行。

实现位于 `src/harness/auto-title/`。
