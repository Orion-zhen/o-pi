# `bash` 工具

## 设计原则

`bash` 使用 Pi 的本地 Shell 后端执行模型提交的命令。后端按事件到达顺序，把标准输出和标准错误写入同一日志。输出捕获从第一个字节开始，模型只接收受字节预算限制的视图。

核心规则：

- 模型只在已启用的专用工具无法完成操作时使用 `bash`，不得绕过已启用的文件工具或网页工具。这是工具路由约束，不是 Shell 命令允许列表。
- 除 Windows 路径兼容处理和已加载技能的 `skill://` 参数解析外，工具不改写命令。
- 工具不对 npm、pytest、Cargo 或 Git 等命令使用专用输出解析器，也不使用大模型总结输出。
- 执行前检查 `deny_patterns` 和 `deny_regex`，但不把 `bash` 变成命令允许列表。
- 输出截断、通用压缩、非零退出、超时、取消或捕获不完整时保留日志。
- 模型可见正文只在输出被截断或捕获不完整时显示 `full` 日志路径。
- 命令成功且输出状态为 `complete` 时返回完整的清理后文本，并删除临时日志。

## 执行环境

每次执行命令时，`bash` 都会复制当前进程环境，并确保 Pi 托管的 `bin` 目录位于 `PATH` 中。工具还会根据当前 Pi 上下文设置以下变量：

- `PI_SESSION_ID`：当前会话 ID。
- `PI_SESSION_FILE`：持久会话文件存在时设置。
- `PI_PROVIDER` 和 `PI_MODEL`：当前模型存在时设置。
- `PI_REASONING_LEVEL`：当前推理级别存在时设置。

工具会先删除继承环境中的旧 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL` 和 `PI_REASONING_LEVEL`，再写入当前值。因此，切换模型或推理级别后，下一条命令会立即读取新值。缺失的可选值不会写为空字符串。

这些变量只注入模型调用的自定义 `bash` 工具。用户输入的 `!` 和 `!!` 命令以及 RPC 的直接 Bash 调用不使用该逻辑。RPC Bash 的 `bash_execution_update` 事件仍由 Pi 核心产生，本工具不会生成或替换该事件。

### Python 虚拟环境

工具按 `python_venv_paths` 的配置顺序选择首个有效的 Python 虚拟环境。有效环境必须包含 `pyvenv.cfg` 和可执行的 Python 解释器。探测到环境后，工具执行以下调整：

- 在非 Windows 平台把环境的 `bin` 目录置于 `PATH` 首位，在 Windows 上使用 `Scripts` 目录。
- 把 `VIRTUAL_ENV` 设置为环境根目录。
- 把 `PIP_REQUIRE_VIRTUALENV` 设置为 `1`。
- 删除 `PYTHONHOME`。

因此，不带路径前缀的 `python`、`pip` 和控制台脚本会优先使用该环境。如果虚拟环境没有 `pip`，`PIP_REQUIRE_VIRTUALENV=1` 会阻止后续找到的全局 `pip` 修改全局环境。

### 技能资源路径

当前分支加载技能后，命令可以把 `skill://<name>/<relative-path>` 作为一个完整且可静态确定的 Shell 参数。例如：

```sh
bash skill://demo/scripts/run.sh
python "skill://demo/scripts/task.py"
skill://demo/scripts/run.sh --flag
```

工具使用 Bash 语法树定位未引用或由单引号、双引号引用的参数。工具验证技能加载记录和真实路径边界，再按 Shell 引用规则转义真实路径并替换定位符。工具拒绝动态拼接的定位符，也拒绝只出现在 `bash -c` 内嵌脚本中的定位符。无效定位符、未加载技能、缺失资源和越过技能根目录的符号链接会在启动进程前失败。工具为这些错误返回退出码 `126`。

该机制只解析路径，不建立只读文件系统。命令仍使用 `bash` 工具原有的进程权限，解析器不会限制命令写入技能目录。

### Windows 路径兼容

在 Windows 上，工具会把命令中的反斜杠路径分隔符转换为正斜杠，同时保留 `\n`、`\t`、`\\` 和引号转义等常见转义序列。其他平台不执行该转换。

## 配置

默认配置位于 `agent/defaults/bash-tool.jsonc`，用户覆盖配置位于 `agent/configs/bash-tool.jsonc`，JSON Schema 位于 `agent/schemas/bash-tool.schema.json`。`bash` 工具只读取用户全局覆盖配置，不读取项目配置。分层规则见[配置分层](configuration.md)。

关键字段：

- `default_timeout_seconds`：工具调用未传入 `timeout` 时使用的超时时间，单位为秒。当前默认值为 `300`。
- `python_venv_paths`：Python 虚拟环境候选路径。相对路径基于命令工作目录解析，绝对路径直接使用。空数组关闭自动探测。
- `limits.success_output_bytes`：成功输出的模型可见字节预算。
- `limits.failure_output_bytes`：非零退出、超时或取消输出的模型可见字节预算。
- `limits.live_output_bytes`：流式更新中最近输出的字节预算。
- `limits.max_capture_bytes`：原始日志最多写入的字节数。达到上限后，工具继续消费进程输出并更新有限的尾部预览，但日志不再完整。
- `safety.deny_patterns`：字符串或简单通配模式拒绝规则。`*` 匹配任意长度文本，`?` 匹配一个字符。模式不含 `*` 或 `?` 时按子字符串匹配。
- `safety.deny_regex`：正则表达式拒绝规则。配置加载时会校验这些表达式，非法表达式会导致配置加载失败。

默认配置包含少量明显危险的命令模式，例如 `rm -rf /`、`mkfs`、`dd ... of=/dev/` 和通过管道把 `curl` 或 `wget` 输出交给 Shell。用户覆盖配置省略 `safety` 时，默认规则仍然生效。只有显式把 `deny_patterns` 和 `deny_regex` 都设置为空数组，才能清空默认规则。

## 安全拒绝规则

命中拒绝规则时，工具不会启动进程。模型会收到以下结果，其中 `pattern` 也可能是 `regex`：

```xml
<error tool="bash" code="BLOCKED_COMMAND">
Command blocked by bash-tool safety deny rule.
Matched pattern: ...
</error>
```

这些规则只提供轻量防护。除静态 `skill://` 参数解析外，`bash` 工具不依据 Bash 抽象语法树限制命令。工具也不限制网络，不修改 `HOME` 或工作目录，也不限制 Shell 语法。工具对执行环境的修改仅包括 Pi 托管的 `bin` 目录、当前 `PI_*` 变量、Python 虚拟环境变量和上述 Windows 路径兼容处理。

## 输出协议

模型可见输出的第一行是稳定头部：

```text
[exit=0 duration=0.42s output=complete lines=18 bytes=1240]
[exit=1 duration=3.04s output=truncated lines=421/18240 bytes=49152/1840213 full=/tmp/...log]
[timeout duration=120.02s output=truncated lines=318/9301 bytes=49152/1840213 full=/tmp/...log]
```

`details` 提供以下机器可读字段：

- `status`、`exit_code` 和 `duration_ms`。
- `output_state` 和 `output_format`。
- `total_lines`、`returned_lines`、`total_bytes` 和 `returned_bytes`。
- `full_output_path` 和 `capture_complete`。

`compacted` 表示模型可见文本经过通用压缩，但未因字节预算而裁剪。该状态会保留原始日志，但头部不显示 `full` 路径。只有 `truncated` 和 `capture_truncated` 状态会在头部显示 `full` 路径。

## 输出状态

- `complete`：模型收到完整的清理后文本。
- `compacted`：工具折叠了进度覆盖、连续重复行或多余空行，但没有按字节预算裁剪文本。原始日志会保留。
- `truncated`：模型只收到预算内预览，`full` 路径指向完整原始日志。
- `capture_truncated`：日志已达到 `max_capture_bytes`，因此 `full` 路径指向的文件也不包含完整输出。后续输出只参与有限的尾部预览。

## 日志生命周期

日志位于系统临时目录：

```text
<tmp>/o-pi/bash/<session-id>/<tool-call-id>.log
```

工具会尽力把目录权限设置为 `0700`，把文件权限设置为 `0600`。文件名不包含命令、参数或输出内容。

命令成功且输出状态为 `complete` 时，工具删除日志。出现 `compacted`、`truncated` 或 `capture_truncated` 状态，以及非零退出、超时或取消时，工具保留日志。如果 Shell 后端在正常执行状态下抛出异常，或输出捕获本身失败，工具会删除不完整日志并向上抛出错误。

## TUI 展示

工具卡收起时，命令和执行结果分别最多显示最近五个视觉行。多行命令和流式结果更新会持续显示最新内容。工具卡展开后显示完整命令和当前结果视图。终端自动换行计入视觉行数，外框、状态和截断提示不占用命令或结果的五行额度。

## 超时和取消

工具为每次调用创建独立的 `AbortController`。用户取消和超时都会通过该控制器停止进程。工具使用本地状态区分 `timed_out` 和 `aborted`，不依赖第三方错误文本。

## 为什么不生成命令专用摘要

命令专用解析器可能遗漏真实错误，并诱导模型重复执行命令。该工具只做与命令无关的输出处理，包括清理 ANSI 控制序列、折叠进度覆盖、折叠连续重复行、压缩空行、保留失败诊断窗口，以及保护 JSON、XML、diff 和二进制输出的结构边界。

日志被保留且未触发 `capture_truncated` 时，原始日志包含进程停止前捕获的完整输出。触发 `capture_truncated` 后，状态头会明确标记日志不完整。
