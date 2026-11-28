# 审批

Approval Gate 在 `tool_call` 中检查 Bash、PowerShell、write、edit 和 webfetch，返回 allow、ask 或 deny。工具获准后仍按自身路径、版本和网络规则执行。

## 默认行为

以下操作通常需要确认：

- `rm -rf` 强制递归删除、Git 强制清理或硬重置、Docker 或 Podman 系统清理。
- 安装、删除和更新软件包。
- 推送、发布和创建发布版本。
- 提权与修改系统状态。
- 部署、删除容器和基础设施变更。
- 动态或无法可靠解析的 Shell 输入。
- `write`、`edit` 写入系统路径，或指定的 Shell 文件操作命令带有系统路径参数。
- webfetch 访问私网，包括通过代理访问回环地址。直连本机回环默认放行。

Bash 和 PowerShell 共用 `tools.shell.default_action` 和审批规则。默认配置下，`git status` 在两种 Shell 中都直接放行，`git push` 都需要确认。

Bash 中普通项目读写、查询、测试和构建通常直接执行。可静态证明只影响临时目录的写入和清理可豁免确认，显式拒绝规则仍优先。

默认匹配条件和动作见 [`approval-gate.jsonc`](../../../agent/defaults/approval-gate.jsonc)。内置事实和组合的 ID 采用 `领域.行为` 格式，段内用 `-` 分词。例如 `tools.shell.facts["history.read"]` 下的 `read-file` 列出了读取命令和历史文件路径。点号是 ID 的一部分。

## PowerShell 审批设计

**审批器要回答的是「模型可能做什么，为什么值得用户决定是否继续」，而不是「这段 PowerShell 会怎样运行」。** 每次弹窗都会打断用户。频繁要求用户确认普通查询或计算，也会让真正重要的提醒更容易被忽略。默认策略下，不弹窗表示没有识别到需要授权的行为，不是对脚本安全性的保证。用户显式配置的询问和拒绝规则仍然生效。

区分「值未知」和「操作未知」。例如 `exit $result` 不必知道退出码的类型或值，`& $result` 却要用这个值决定执行哪条命令。又如 `if ($count -gt $limit) { git push }`，不必预测比较结果就能提醒用户「可能推送到远端」。需要用户决定的是要不要推送，不是要不要接受一次分析失败。

维护分析器时，先问：**省掉这段分析，会漏掉什么值得提醒的行为，或造成什么常见误报？** 能指出具体例子，再跟踪相关的值、路径或分支。不要为了证明普通查询无害而穷举只读命令、参数或对象属性，也不要为了判定表达式是否合法而重写解释器。查询里若包含受保护的读取、重定向或嵌套调用，仍检查这些操作。

### 分析范围

分析器同时检查原始命令和最终执行脚本：

- `|` 保留管道阶段，`&&` / `||` 分开分析。条件、循环、`$()`、插值和可能被调用的脚本块中的命令也参与规则匹配。本地函数在静态调用时展开，未调用函数中的嵌套定义不参与匹配。
- 按执行顺序跟踪普通变量、`$env:`、简单字符串插值、有限 `foreach` 和本地函数参数。条件无法确定时检查各分支。`iex` / `Invoke-Expression` 和 `pwsh` / `powershell -Command` 的代码参数能确定时另行解析，不执行代码、不读取外部脚本。
- 文件重定向产生独立的 `write_redirect` 单元。流合并和 `$null` 不算文件写入。相对目标按可能的文件系统位置分别检查。暂时无法确定位置时，已知路径仍可触发拒绝，但不能据此豁免未知目标。
- `git status; git push` 中，推送可单独记为会话授权。依赖启动环境、包含未解析输入或经技能路径改写的调用不记忆。审批面板只列出分析用到的启动值，敏感值默认隐藏。两种 Shell 不共享授权。

PowerShell 直接调用 `cmd /c` 时，可用 `command: ["cmd:{rd,rmdir}", "/s"]` 配合 `arg_globs` 匹配内层命令。开关不区分大小写，也不要求在路径之前。默认规则 `filesystem.delete-drive-root` 拒绝递归删除盘根。已识别 `/s` 但目标不确定时按可能命中询问，普通子目录不命中。这不是完整的 CMD 解释器，不展开 CMD 环境变量或复合脚本。

支持的分支、位置和临时范围见 [PowerShell 分析](rules.md#powershell-分析)。

## 选择

| GUI 按钮 | TUI / RPC 选项 | 效果 |
| --- | --- | --- |
| 允许一次 | Allow once | 放行当前调用 |
| 本会话允许 | Allow for session | 放行当前调用并保存会话授权。仅当所有待审批单元都能精确记忆时提供 |
| 拒绝 | Deny | 拒绝调用 |
| 拒绝并说明 | Deny with instruction | 拒绝并把附加指令返回给代理 |

两种 shell 的授权按工具名和工作目录隔离。webfetch 放行绑定完整 origin 和网络范围。

TUI 的方向键选择操作，PageUp/PageDown 浏览内容，Enter 确认，Esc 或 Ctrl+C 拒绝。GUI 展示结构化命令、敏感单元和文件内容，RPC 使用选择与输入接口。

在 GUI 中选择「拒绝并说明」后，工具调用已被拒绝。原弹窗保留请求详情，底部切换为多行说明框。发送说明会把内容交给代理。跳过说明、按 Esc 或等待超时均不附加指令。

审批扩展发出请求和完成事件，前端据此发送[系统通知](../runtime/notifications.md)。

## 配置

用户文件为 `~/.pi/agent/configs/approval-gate.jsonc`，可用 `PI_APPROVAL_GATE_CONFIG` 指定路径。

| 字段 | 含义 |
| --- | --- |
| `enabled` | 总开关 |
| `ui.timeout_ms` | 确认超时，0 表示不限时 |
| `ui.non_interactive` | 无界面时 block 或 allow，默认 block |
| `ai_review.enabled` | AI 辅助审批，默认关闭。只在 GUI 或 TUI 弹窗中运行，RPC 和无界面调用沿用原策略 |
| `ai_review.model` | `null` 使用当前会话模型，也可指定 `provider/model` |
| `ai_review.thinking_level` | 按审批模型支持的等级调整，默认 `off` 取最低可用等级。不继承或改变主会话的思考等级 |
| `ai_review.auto_apply_seconds` | 收到建议后等待多少秒再自动采纳。默认 `0`，只展示建议 |
| `ai_review.max_turns` | 最多发送几轮对话，默认 3，当前未完成的一轮也占一个名额 |
| `ai_review.max_tool_calls` | 最多发送几次历史工具调用，默认 20，0 表示不带历史调用 |
| `tools.<tool>.default_action` | 未命中规则时的动作 |
| `tools.<tool>.facts` | 按 ID 配置事实的匹配条件、动作和审批原因 |
| `tools.shell.combinations` | 事实组合的升级决策 |

在 `tools.shell` 的事实、命令分类器或组合上可写 `"shell": "bash"` 或 `"shell": "powershell"`。省略 `shell` 时规则适用于两者。一个事实下只有部分命令需要区分 Shell 时，只在对应分类器上写 `shell`。

用户配置只需写要修改的字段。例如，将两种 Shell 读取历史记录的动作都由拒绝改为询问，保留默认命令和路径：

```jsonc
{ "tools": { "shell": { "facts": { "history.read": { "action": "ask" } } } } }
```

要禁用这条事实，将 `"history.read"` 的值设为 `false`。

关闭总开关会跳过调用策略。需要不可绕过的权限隔离时，在进程外使用低权限账号或沙箱。

## AI 辅助审批

在 GUI 的「设置 → 权限与安全 → AI 辅助审批」中选择审批模型后，「思考等级」只列出该模型支持的等级。选择「使用当前模型」时，列表随会话模型变化。

```jsonc
{ "ai_review": { "enabled": true } }
```

审批开始时并行请求模型。默认只展示建议，仍按 `ui.timeout_ms` 等待用户决定。若 `auto_apply_seconds` 为正数，且在超时前收到有效建议，宿主会用自动采纳倒计时替换原期限。GUI 会话在后台或弹窗尚未显示时，倒计时也会生效。手动选择立即终止 AI 审批。

若 Shell 分析用到了非空的敏感环境变量，或 webfetch 对查询参数做了脱敏，审批器直接等待人工决定，不读取历史或请求评审模型。模型不可用、上下文超限、回复格式不符或理由为空白时也保留原期限。

GUI 用 Bot 图标和高亮边框标出建议的按钮。仅在启用自动采纳时，按钮底色显示倒计时进度。AI 只能允许一次或拒绝。审批器只采纳一次有效的 `submit_review` 工具调用，忽略附带正文。自动拒绝的原因会作为 AI 意见返回给主代理，不作为用户指令。只有手动选择「允许一次」才会启用审批弹窗的 sudo 密码输入。

启用后，所选模型提供商会收到当前调用、工作目录、询问原因，以及当前分支最近的用户和助手正文。连续同角色发言不另算一轮。即使助手只调用工具，下一条用户消息也算新的一轮。当前待审的 `write` 或 `edit` 仍发送完整写入正文或修改前后文本，其中可能包含敏感数据。

历史工具调用单独计数。每条记录发送工具名和状态，`write`、`edit` 只附路径，`bash`、`powershell` 附完整命令，不按长度截断。若会话未保留嵌套调用的参数，则标记为缺失。审批上下文不包含工具结果正文或思考过程。

## 检查与专题

```text
/approval-check git push origin main
/approval-check --powershell Get-Item README.md
```

命令显示配置策略、事实、分类器和组合，解析但不执行 Shell。

[Bash 分析与规则](rules.md)记录解析、临时范围、路径匹配和会话授权。实现位于 `src/harness/approval/`，Pi 入口为 `src/harness/extensions/approval-gate.ts`。
