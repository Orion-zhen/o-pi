# Bash 工具

`bash` 使用 Pi 的本地 Shell 后端执行命令，按事件到达顺序合并 stdout 和 stderr。模型接收有界输出，必要时可读取保留日志。

## 参数与配置

```json
{ "command": "git status", "workdir": "packages/app", "timeout": 30 }
```

`workdir` 相对工作区解析，省略或为空时使用工作区根目录。虚拟环境探测、相对路径和审批单元都基于该目录。

`timeout` 单位为秒，范围大于 0 且不超过 86400。省略时使用 `default_timeout_seconds`，默认 300。

默认配置见 [`bash-tool.jsonc`](../../../agent/defaults/bash-tool.jsonc)。用户覆盖为 `~/.pi/agent/configs/bash-tool.jsonc`，可用 `PI_BASH_TOOL_CONFIG` 指定路径。

| 字段 | 含义 |
| --- | --- |
| `python_venv_paths` | 按顺序探测的 Python 虚拟环境 |
| `environment.inherit` | 继承当前进程环境 |
| `environment.remove_name_regex` | 删除匹配名称的继承变量 |
| `environment.expose_pi_session_file` | 暴露会话文件路径 |
| `limits.success_output_bytes` | 成功输出预算 |
| `limits.failure_output_bytes` | 失败、超时和取消输出预算 |
| `limits.live_output_bytes` | 实时输出预算 |
| `limits.max_capture_bytes` | 日志字节上限 |

## 执行环境

继承变量先经过过滤，再确保 Pi 的 `bin` 目录位于 PATH。Windows 按大小写不敏感方式匹配变量名，其他平台按原始大小写匹配。

每次调用更新 `PI_SESSION_ID`、`PI_PROVIDER`、`PI_MODEL` 和 `PI_REASONING_LEVEL`。启用会话文件暴露且文件存在时设置 `PI_SESSION_FILE`。缺失的可选值会清除。

这些变量用于模型的 `bash` 工具。用户 `!`、`!!` 和 RPC 直接 Bash 使用 SDK 自己的执行流程。

虚拟环境须包含 `pyvenv.cfg` 和可执行 Python。首个有效环境的 `bin` 或 `Scripts` 放到 PATH 首位，同时设置 `VIRTUAL_ENV`、`PIP_REQUIRE_VIRTUALENV=1` 并删除 `PYTHONHOME`。候选相对路径按工作目录解析，空数组关闭探测。

## 技能路径

已加载技能可以使用完整的静态参数：

```bash
python "skill://demo/scripts/report.py"
```

工具通过 Bash 语法树定位参数，检查技能记录与真实路径边界，再替换为经过 Shell 转义的路径。动态拼接或只出现在 `bash -c` 内嵌脚本中的定位符会被拒绝。路径错误在启动进程前返回退出码 126。

## sudo 认证

命令默认使用宿主进程权限。在 macOS 和 Linux 上，TUI、WebUI 和 Desktop 支持为单条静态 `sudo <程序> <参数>` 命令提供密码。用户选择“允许一次”后，工具通过系统 `sudo -A` 执行这条命令。此类调用不记为会话授权。只有 `sudo` 索取密码时才显示密码框，密码不进入会话记录。

- TUI 关闭审批面板后按需打开密码框，输入不回显。Enter 提交，Esc 或 Ctrl+C 取消。重试时需要重新输入。
- WebUI 和 Desktop 只在批准命令的页面显示密码框，并保留审批详情。尚未索取密码时，关闭详情只会隐藏面板。取消密码输入、切换会话或断开连接会结束待处理的认证，重连不会恢复旧密码框。远程 HTTP 连接不加密密码，部署者负责访问控制和传输安全。

RPC 和 Windows 保留原 Bash 执行方式，不接入密码框。即使在支持密码框的界面，自动放行的命令，以及包含 sudo 选项（如 `-n`）、管道、重定向或动态展开的命令，也按原样执行。调用策略见[审批](../approval-gate/README.md)。Windows Bash 路径建议使用 `C:/path/to/file`，含空格时加引号。

## 输出

状态头示例：

```text
[exit=0 duration=0.42s output=complete]
[exit=1 duration=3.04s output=truncated full=/tmp/...log]
[timeout duration=120.02s output=truncated full=/tmp/...log]
[timeout shell_exit=7 shell_exit_after=0.1s background_output=true duration=120.02s output=complete]
```

| 状态 | 含义 |
| --- | --- |
| `complete` | 返回完整的清理后文本 |
| `compacted` | 折叠进度覆盖、连续重复行或多余空行 |
| `truncated` | 返回预算内预览 |
| `capture_truncated` | 捕获达到上限，日志本身也不完整 |

字节预算按清理后的 UTF-8 正文计算，含预览与省略标记。状态头单独保留。失败预览优先保留已捕获窗口中的错误行和上下文，其余预算用于首尾。

`details` 包含状态、退出码、耗时、输出状态、行数、字节数、日志路径和 `capture_complete`。若 shell 已退出，但后台进程持续输出直到超时，保留实际 `exit_code` 和 `shell_exit_after_seconds`，状态仍为 `timed_out`。执行中更新返回有界最近输出，结束后生成最终元数据。

Codemode 读取最多 1 MiB 的独立原始文本结果，超限保留头尾。字段见 [Codemode 结果](../codemode/README.md#结果)。

## 日志与取消

日志位置为 `<tmp>/o-pi/bash/<session-id>/<tool-call-id>.log`。目录请求 `0700`，文件请求 `0600`，Windows 按平台权限处理。

命令成功且模型、脚本输出均完整时删除日志。压缩、截断、非零退出、超时或取消会保留日志，模型状态头只在截断或捕获不完整时显示路径。

超时和进程取消由 Pi 本地后端管理，工具将后端结果转换为超时或用户取消状态。日志创建或写入失败不改变命令状态和内存预览。需要保留日志时，结果用 `full_output_error` 返回失败原因，不提供日志路径。

实现位于 `src/harness/bash-tool/`。输出捕获、清理和预览分别由 `output-capture.ts`、`output-view.ts`、`output-preview.ts` 管理。
