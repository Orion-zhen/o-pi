# bash tool

## 设计原则

`bash` 原样执行模型提供的命令，并从第一字节开始把 stdout/stderr 按后端事件顺序写入同一日志。模型只接收有字节预算的视图。

核心规则：

- 模型只在 active 专用工具未覆盖操作时使用 `bash`，不得绕过 active file/web tools；这是路由约束，不是 shell allowlist。
- 不改写命令，不做 npm、pytest、Cargo、git 等专用输出解析。
- 工作目录存在 `.venv`、`venv`、`env`、`.env`、`pyvenv`、`pyenv`、`.pyvenv` 或 `.pyenv`，包含 `pyvenv.cfg` 和可执行 Python 时，自动把其 `bin`（Windows 为 `Scripts`）置于 `PATH` 首位、设置 `VIRTUAL_ENV`、启用 `PIP_REQUIRE_VIRTUALENV` 并移除 `PYTHONHOME`；无路径前缀的 `python`、`pip` 及 console scripts 因而优先使用该环境，缺少 venv pip 时也不会修改全局环境。
- 执行前只做轻量 deny pattern / regex 检查，不把 bash 改成 allowlist。
- 不用 LLM 总结输出。
- 截断、压缩、失败、超时、取消或捕获不完整时保留日志路径。
- 模型可见正文只在输出真正截断或捕获不完整时提示 `full` 日志路径。
- 小型成功输出完整返回，并删除临时日志。

## 配置

配置文件：`agent/configs/bash-tool.jsonc`，schema：`agent/schemas/bash-tool.schema.json`。文件完整列出当前有效配置，便于直接修改。

- `default_timeout_seconds`：未传 `timeout` 时的秒数。内置默认值为 `120`；本仓库配置覆盖为 `300`。
- `limits.success_output_bytes`：成功输出视图预算。
- `limits.failure_output_bytes`：失败、超时、取消输出视图预算。
- `limits.live_output_bytes`：流式更新只展示最近输出的预算。
- `limits.max_capture_bytes`：原始日志最多写入字节数；超过后继续消费进程输出，但日志不再完整。
- `safety.deny_patterns`：轻量字符串 / glob 风格黑名单。`*` 匹配任意文本，未包含 glob 字符时按 substring 匹配。
- `safety.deny_regex`：正则黑名单。配置加载时校验，非法正则会使配置加载失败。

内置默认配置包含少量明显危险命令模式，例如 `rm -rf /`、`mkfs`、`dd ... of=/dev/` 和 `curl|wget | sh`。省略 `safety` 时仍使用这些默认规则；只有显式把 `deny_patterns` 和 `deny_regex` 都设为空数组才会清空它们。

命中黑名单时不会启动进程，模型收到：

```xml
<error tool="bash" code="BLOCKED_COMMAND">
Command blocked by bash-tool safety deny rule.
Matched regex: ...
</error>
```

这只是 lightweight guardrail：不解析 bash AST、不限制网络、不改 `HOME` / cwd、不限制 shell 语法。除上述 Python 虚拟环境自动解析外，不改执行环境。

## 输出协议

第一行是稳定头部：

```text
[exit=0 duration=0.42s output=complete lines=18 bytes=1240]
[exit=1 duration=3.04s output=truncated lines=421/18240 bytes=49152/1840213 full=/tmp/...log]
[timeout duration=120.02s output=truncated lines=318/9301 bytes=49152/1840213 full=/tmp/...log]
```

`details` 保留机器可读字段：状态、退出码、耗时、输出状态、格式、总行数/返回行数、总字节/返回字节、日志路径和捕获完整性。

`compacted` 表示输出已通用降噪但信息完整，正文不会提示读取日志；`truncated` 和 `capture_truncated` 才会在头部显示 `full=...`。

## 日志生命周期

日志位于系统临时目录：

```text
<tmp>/o-pi/bash/<session-id>/<tool-call-id>.log
```

目录尽量设置为 `0700`，文件尽量设置为 `0600`。文件名不包含命令、参数或输出内容。

小型成功输出完整返回时删除日志。输出被截断、压缩、失败、超时、取消或 `max_capture_bytes` 触发时保留日志。

## 输出状态

- `complete`：模型看到完整输出。
- `compacted`：模型看到完整语义窗口，但 ANSI、进度覆盖、重复行或空行被通用压缩；原始日志保留。
- `truncated`：模型只看到预算内预览，完整日志可读。
- `capture_truncated`：日志达到 `max_capture_bytes`，文件不是完整输出；后续输出只参与有限尾部预览。

## timeout 和取消

工具创建内部 `AbortController`。用户取消和 timeout 都通过内部 signal 停止进程，并用本地状态区分 `timed_out` 与 `aborted`，不解析第三方错误字符串。

## 为什么不做命令专用摘要

专用解析器容易遗漏真实错误并诱导重复执行。该工具只做安全通用降噪：ANSI 清理、进度覆盖折叠、连续重复行折叠、空行压缩、失败诊断窗口和结构化输出保护。完整事实始终以原始日志为准。
