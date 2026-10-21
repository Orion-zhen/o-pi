# 子代理执行

`executeSubagent()` 是模型工具与 `/run` 的共同入口，通过进度事件报告 starting、running 和 completed。调用由会话执行注册表跟踪，结束释放，关闭会话时取消仍在运行的进程。

## 进程

子进程通过共享 headless 入口运行 Pi JSON 模式，设置 `PI_SUBAGENT_CHILD=1`，显式传递工具集合，并使用环境变量白名单。

隔离任务把 Agent Markdown 交给 `--system-prompt`，解析正文作为子代理角色，保留自身工作目录的项目规则。

fork 将父请求的完整系统提示词写入受限临时文件，选定分支的消息和上下文编辑写入快照。工具调用从当前 assistant 条目之前分叉，`/run` 从当前叶节点分叉。正文与任务追加为一次用户输入。

同批任务共享只读快照，每个任务与重试创建独立子会话。执行完成后清理快照、提示词和子会话临时文件。输出结果另行保存。

## 写入确认

有写能力的代理按配置请求确认。无交互端口时拒绝需要确认的任务。可信用户定义可通过 `auto_confirm: true` 跳过。

Fork 的模型、工具和目录继承主会话，Agent/config 中的对应字段不生效。

## 流与成功条件

stdout 按 Pi JSONL 解析。消息 delta 提供实时正文，message_end 作为最终结果，工具事件更新 pending、running、completed 和 error。高频进度最多每 50ms 汇总一次。

成功需要退出正常、最终助手文本非空，且没有错误停止原因。`stopReason: "length"` 视为截断失败，保留部分输出并停止后续链式任务。损坏 JSONL 使任务失败。

stderr 完整保存，展示时按预算截断。超时与取消先发 SIGTERM，宽限后 SIGKILL。

## 重试

只读任务默认对空输出、连接或提供方失败、非零退出和错误停止原因重试一次。超时重试由 `retry_on_timeout` 控制。

外部取消、模型输出上限、损坏 JSONL、写能力任务，以及已观察到 write、edit 或 bash 的任务不重试。每次重试从同一初始快照开始。

链式任务失败后停止，并行任务默认继续其他任务。

## 输出

完整结果保存在：

```text
.pi/subagents/runs/<run-id>/
```

本地同步计数器决定是否内联。未超过 `max_inline_output_tokens` 时返回正文，超过时返回文件路径和读取指引。

链式传递同时检查内联和 `max_handoff_tokens` 预算，超过任一预算时改传路径。

TUI 与 GUI 展示各任务的状态、活动、耗时、输出和文件位置。`/run` 的结果卡片保存在会话历史，不进入模型上下文。

## 复用与缓存

fork 尽量保留父请求的提示词、工具声明、消息前缀、模型与会话亲和性。实际缓存命中由提供方的预算、TTL 和路由决定。

实现位于 `src/harness/subagent/`，终端呈现位于 `src/tui/chat/subagent/`。
