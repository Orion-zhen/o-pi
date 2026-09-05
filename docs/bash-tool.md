# `bash` 工具

## 设计原则

`bash` 使用 Pi 的本地 Shell 后端执行模型提交的命令。后端按事件到达顺序，把标准输出和标准错误写入同一日志。输出捕获从第一个字节开始，模型只接收受字节预算限制的视图。

核心规则：

- 模型只在已启用的专用工具无法完成操作时使用 `bash`，不得绕过已启用的文件工具或网页工具。这是工具路由约束，不是 Shell 命令允许列表。
- 除已加载技能的 `skill://` 参数解析外，工具不改写命令。
- 工具不对 npm、pytest、Cargo 或 Git 等命令使用专用输出解析器，也不使用大模型总结输出。
- 输出截断、通用压缩、非零退出、超时、取消或捕获不完整时保留日志。
- 模型可见正文只在输出被截断或捕获不完整时显示 `full` 日志路径。
- 命令成功且输出状态为 `complete` 时返回完整的清理后文本，并删除临时日志。

## 执行环境

每次执行命令时，`bash` 根据 `environment.inherit` 决定是否继承当前进程环境。继承时，工具先用 `environment.remove_name_regex` 删除匹配的变量名，再确保 Pi 托管的 `bin` 目录位于 `PATH` 中。非 Windows 平台按原始大小写匹配变量名，Windows 使用大小写不敏感匹配。

工具还会根据当前 Pi 上下文设置以下变量：

- `PI_SESSION_ID`：当前会话 ID。
- `PI_SESSION_FILE`：仅当 `environment.expose_pi_session_file` 为 `true` 且持久会话文件存在时设置。默认不暴露。
- `PI_PROVIDER` 和 `PI_MODEL`：当前模型存在时设置。
- `PI_REASONING_LEVEL`：当前推理级别存在时设置。

工具会先删除继承环境中的旧 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL` 和 `PI_REASONING_LEVEL`，再写入当前值。因此，切换模型或推理级别后，下一条命令会立即读取新值。缺失的可选值不会写为空字符串。

`remove_name_regex` 只过滤继承变量，不过滤工具随后注入的 `PI_SESSION_ID`、provider、model 和 reasoning level。`PI_SESSION_FILE` 由独立开关控制。

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

### Windows 路径

工具会原样传递反斜杠，不尝试区分路径分隔符、Shell 转义和正则转义。Windows 路径应使用当前 Shell 能直接解析的形式。使用 Bash 时，优先写成 `C:/path/to/file`，含空格的路径还应按 Shell 规则引用。

## 配置

默认配置位于 `agent/defaults/bash-tool.jsonc`，用户覆盖配置位于 `agent/configs/bash-tool.jsonc`，JSON Schema 位于 `agent/schemas/bash-tool.schema.json`。`bash` 工具只读取用户全局覆盖配置，不读取项目配置。分层规则见[配置分层](configuration.md)。

关键字段：

- `default_timeout_seconds`：工具调用未传入 `timeout` 时使用的超时时间，单位为秒。当前默认值为 `300`。单次调用的 `timeout` 必须大于 `0` 且不超过 `86400`。
- `python_venv_paths`：Python 虚拟环境候选路径。相对路径基于命令工作目录解析，绝对路径直接使用。空数组关闭自动探测。
- `environment.inherit`：是否继承 Pi 进程环境。
- `environment.remove_name_regex`：从继承环境中删除变量名的正则列表。
- `environment.expose_pi_session_file`：是否向模型调用的 Bash 暴露 `PI_SESSION_FILE`。
- `limits.success_output_bytes`：成功输出的模型可见字节预算。
- `limits.failure_output_bytes`：非零退出、超时或取消输出的模型可见字节预算。
- `limits.live_output_bytes`：流式更新中最近输出的字节预算。
- `limits.max_capture_bytes`：原始日志最多写入的字节数。达到上限后，工具继续消费进程输出并更新有限的尾部预览，但日志不再完整。

## 调用策略

Approval Gate 在统一的 `tool_call` 钩子中评估 Bash 调用策略。Bash 工具只接收已经放行的调用，不解析安全事实，也不显示审批界面。Bash 安全事实、`allow`、`ask`、`deny` 和 `/approval-check` 的配置见 [Approval Gate](approval-gate.md#配置)。

关闭 Approval Gate 会统一跳过 Bash 调用策略。Bash 工具仍会检查技能资源路径、运行环境、超时和输出限制，但这些检查不替代调用策略或操作系统隔离。

## 输出协议

模型可见输出的第一行是稳定头部：

```text
[exit=0 duration=0.42s output=complete]
[exit=1 duration=3.04s output=truncated full=/tmp/...log]
[timeout duration=120.02s output=truncated full=/tmp/...log]
```

`details` 提供以下机器可读字段：

- `status`、`exit_code` 和 `duration_ms`。
- `output_state` 和 `output_format`。
- `total_lines`、`returned_lines`、`total_bytes` 和 `returned_bytes`。
- `full_output_path` 和 `capture_complete`。

`compacted` 表示模型可见文本经过通用压缩，但未因字节预算而裁剪。该状态会保留原始日志，但头部不显示 `full` 路径。只有 `truncated` 和 `capture_truncated` 状态会在头部显示 `full` 路径。

字节预算按清理后的 UTF-8 文本计算，包括预览标签和省略标记，不包括第一行状态头。`total_bytes` 统计原始字节，`returned_bytes` 统计正文。无效 UTF-8 的替代字符和控制字符可见化可能使返回字节数大于原始字节数，因此不能用两者的大小关系判断预览是否完整。

执行中的更新只提供 `[running ...]` 和有界的最近输出，不填充最终执行元数据。`details` 在执行结束后生成。

## 输出状态

- `complete`：模型收到完整的清理后文本。
- `compacted`：工具折叠了进度覆盖、连续重复行或多余空行，但没有按字节预算裁剪文本。原始日志会保留。
- `truncated`：模型只收到预算内预览，`full` 路径指向完整原始日志。
- `capture_truncated`：日志已达到 `max_capture_bytes`，因此 `full` 路径指向的文件也不包含完整输出。后续输出只参与有限的尾部预览。

## 输出处理边界

- `output-capture.ts` 负责日志和原始字节统计。内存中的固定大小窗口明确区分完整字节与不连续的头尾片段，窗口大小同时考虑成功、失败和实时输出预算。
- `output-view.ts` 负责解码、清理、输出状态和日志保留策略。头尾片段分别清理，不跨越原始缺口折叠进度或重复行。
- `output-preview.ts` 在预算内选择正文，然后只渲染一次。失败输出优先保留错误行和相邻上下文，剩余预算用于首尾，不再对已选诊断进行通用二次裁剪。

原始预览存在缺口时，正文显示 `raw bytes outside preview` 标记。即使清理后正文很短，状态仍为 `truncated` 或 `capture_truncated`。结构化输出的预览同时声明文档不完整。

诊断选择只覆盖内存中的预览片段，不扫描完整日志。预览之外的诊断需要通过保留的日志读取。Pi 的同步输出回调不支持背压，预览预算也不限制文件流的待写入队列。

## 日志生命周期

日志位于系统临时目录：

```text
<tmp>/o-pi/bash/<session-id>/<tool-call-id>.log
```

工具创建目录时请求 `0700`，创建文件时请求 `0600`。POSIX 平台无法设置这些权限时执行失败；Windows 不提供完整的 POSIX mode 语义。文件名不包含命令、参数或输出内容。

命令成功且输出状态为 `complete` 时，工具删除日志。出现 `compacted`、`truncated` 或 `capture_truncated` 状态，以及非零退出、超时或取消时，工具保留日志。

捕获器从创建文件流时开始监听异步写入错误，并等待流关闭后返回。Shell 后端在非超时、非取消状态下抛出异常，或输出捕获失败时，工具先释放文件流，再删除日志并向上抛出错误。非取消、非超时的后端异常优先于捕获或清理异常。

## TUI 展示

工具卡收起时，命令和执行结果分别最多显示最近五个视觉行。多行命令和流式结果更新会持续显示最新内容。工具卡展开后显示完整命令和当前结果视图。终端自动换行计入视觉行数，外框、状态和截断提示不占用命令或结果的五行额度。

## 超时和取消

工具为每次调用创建独立的 `AbortController`。用户取消和超时都会通过该控制器停止进程。工具使用本地状态区分 `timed_out` 和 `aborted`，不依赖第三方错误文本。

## 为什么不生成命令专用摘要

命令专用解析器可能遗漏真实错误，并诱导模型重复执行命令。该工具只做与命令无关的输出处理，包括清理 ANSI 控制序列、折叠进度覆盖、折叠连续重复行、压缩空行、保留失败诊断窗口，以及保护 JSON、XML、diff 和二进制输出的结构边界。

日志被保留且未触发 `capture_truncated` 时，原始日志包含进程停止前捕获的完整输出。触发 `capture_truncated` 后，状态头会明确标记日志不完整。
