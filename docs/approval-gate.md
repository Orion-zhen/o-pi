# Approval Gate 审批机制

`approval-gate` 在 `tool_call` 钩子中统一执行工具调用策略。策略可以放行、要求用户确认或拒绝调用。Approval Gate 不是沙箱或工作区权限系统。

执行顺序：

1. 读取 Approval Gate 配置。
2. 构建工具审批请求。Bash 请求在此阶段使用 Tree-sitter 解析。`webfetch` 请求在此阶段解析目标地址。
3. 评估路径规则、Bash 安全事实和已记住的放行规则。
4. 策略为 `deny` 时阻止工具调用。
5. 策略为 `ask` 时显示审批界面，并根据用户选择放行或阻止调用。
6. 策略为 `allow` 或用户批准后执行工具。

审批策略判定为 `ask` 且存在交互式界面时，Approval Gate 会先尝试发送系统通知，再显示审批选择框。通知失败不影响审批。用户拒绝后，Approval Gate 返回 `{ block: true, reason }`，但不调用 `ctx.abort()`。

`ApprovalGate` 仅通过 `ApprovalInteractionPort` 的 `approve`、`input` 和 `notify` 方法访问交互界面，不依赖 Pi TUI。当前扩展在 `ctx.hasUI` 为 `true` 时通过 Pi UI 注入该端口。JSON 模式和打印模式没有该端口，因此使用 `ui.non_interactive` 策略。

## 审批界面

TUI 模式使用高度受限的覆盖面板。面板把请求内容和审批操作分开布局：

- 顶部显示工具名称。
- 中部显示工作目录、触发原因和请求内容。超出可用高度时，只滚动这个区域。
- 底部显示审批操作和按键提示。请求内容不会把操作区域推出屏幕。

`Up` 和 `Down` 选择操作，`PageUp`、`PageDown`、`Home` 和 `End` 浏览请求内容，`Enter` 确认，`Esc` 或 `Ctrl+C` 拒绝。终端高度不足以同时显示所有操作时，操作列表会跟随当前选择滚动。

请求内容按工具展示：

- `bash` 显示完整 Shell 输入和触发确认的敏感单元。
- `write` 显示目标路径和完整拟写入内容。每一行使用新增标记展示。
- `edit` 按替换项显示原文本、新文本和 `replace_all` 状态。
- `webfetch` 显示目标 URL、origin 和解析到的地址。

TUI 面板会移除请求内容中的终端控制序列，避免内容改变终端显示状态。RPC 模式继续使用 Pi 的基础选择框，并在标题中包含相同的请求信息。

## 与工具运行约束的区别

Approval Gate 负责所有 `allow`、`ask` 和 `deny` 调用策略，包括 Bash 安全事实和用户定义的路径规则。Bash 工具不再重复评估这些策略。

工具仍负责自身的运行约束。例如，文件工具在执行时检查 `blocked_path`、路径解析和并发修改。`webfetch` 在网络边界复检 URL、重定向和 DNS，并只对获批 origin 使用审批时固定的地址。用户批准只表示允许工具尝试执行，不保证工具操作成功。

Approval Gate 和工具运行约束都不提供进程、网络或操作系统权限隔离。需要不可绕过的隔离时，应在 Pi 进程外使用低权限账号、容器或平台专用沙箱。

## Bash 解析与审批单元

共享语法解析层使用 `tree-sitter-bash` 的 WASM 语法解析 `bash` 输入。C、C++、Go、JavaScript/JSX、TypeScript/TSX、Python、Rust 和 Bash 共用 `web-tree-sitter` 运行时、语言目录和解析器缓存。Bash 注册项还允许代码索引自动识别并解析 `.sh` 文件。

Approval Gate 不把整段 Shell 文本作为一个审批目标，而是提取以下单元：

- 管道、`&&`、`||` 和 `;` 等结构中的简单命令。
- 命令替换和进程替换中的嵌套命令。
- 可静态确定的 `bash`、`sh` 和 `zsh` 等 Shell 的 `-c` 参数中的子脚本。
- `>`、`>>`、`>|`、`&>` 和 `&>>` 等文件写重定向。`2>&1` 等文件描述符复制不属于文件写入。
- 具有有限字面量取值的 `for` 循环中的命令变量。例如，`for engine in xelatex lualatex` 会产生两个具体命令供分析。

Bash 安全事实分类器逐单元匹配命令正则，也可以匹配完整原始输入。一次工具调用只显示一个聚合审批框。安全事实或 `deny_rules` 判定为 `deny` 时，任何已记住的放行规则都不能覆盖该决定。审批框会汇总需要确认且未被放行规则覆盖的单元。用户批准后，工具仍执行原始完整命令。

解析器会按执行顺序跟踪变量和 `$PWD`。裸赋值以及 `declare`、`readonly` 和 `export` 中的赋值都参与跟踪。变量经过多次赋值后，只要当前值仍可确定，后续命令就能继续使用该值。所有控制流分支都落在临时范围时，解析器会合并分支结果。函数定义本身不产生审批单元。静态可确定的函数调用和 `EXIT` trap 会在调用时使用对应上下文分析函数体。

解析器把 `mktemp` 成功创建的路径视为一次性临时路径。支持的静态形式包括无参数调用、`-d`、静态模板、`--suffix`、`--tmpdir` 和 `-p`。`-u`、`--dry-run`、动态选项和无法识别的选项不获得临时路径豁免。解析器还会向静态 Shell `-c` 子脚本传播当前工作目录和位置参数。

系统临时目录的后代也属于临时范围。非 Windows 平台的内置临时目录根包括 `/tmp`、`/var/tmp`、`/private/tmp` 和 `/private/var/tmp`。macOS 还包括位于 `/var/folders/` 下的当前运行时临时目录。Windows 使用当前运行时临时目录。临时根下的 glob、进程编号等动态文件名不需要得到完整文件名，只要分析器能够证明所有可能结果仍位于临时范围即可。

解析器能够证明目标完全位于临时范围时，文件写重定向、`rm`、不带父目录删除选项的 `rmdir`，以及临时工作目录内的 `git clean` 和 `git reset --hard` 不触发 `ask`。`git -C` 指向已证明的临时工作区时也适用。`write` 和 `edit` 写入系统临时目录后代时使用同一规则。显式 `deny_rules` 仍可阻止这些单元。

临时范围必须能够静态证明。系统临时目录根本身不属于可豁免目标。未加引号且可能发生分词的变量、通过 `..` 逃出临时目录根、同时包含临时和非临时目标、`rmdir -p`、`sudo`、`--git-dir`、`--work-tree`、结果可能落在不同范围的分支，以及没有通过 `&&` 保护的 `cd` 都无法获得临时路径豁免。

出现语法错误、语法资源或运行时不可用、分析超时、嵌套过深或单元过多时，Approval Gate 会把整段输入降级为不透明单元。该单元的策略匹配视图以 `<opaque>` 开头，可以生成会话放行规则，但不能生成持久放行规则。动态命令名使用 `<dynamic>` 占位。无法静态解析的 Shell `-c` 子脚本也不能生成持久放行规则。动态写重定向无法生成范围明确的放行规则，因此只提供一次性批准。

## 默认要求确认

以下调用默认判定为 `ask`：

- `rmdir`、`rm -rf`、`git reset --hard`、带强制选项的 `git clean` 和 `docker system prune`。已证明只影响临时范围的调用除外。
- 使用 `apt`、`apt-get`、`brew`、`cargo`、`dnf`、`gem`、`npm`、`pip`、`pip3`、`pnpm`、`uv`、`yarn` 或 `yum` 安装、删除或更新软件包，以及 `go install` 和带 `S`、`R` 或 `U` 操作选项的 `pacman`。
- `git push`、`docker push`、`twine upload`、`npm publish`、`pnpm publish`、`yarn publish` 和 `cargo publish`，以及 `gh release` 的 `create`、`delete`、`edit` 和 `upload` 子命令。
- `sudo`，以及 `systemctl`、`service` 和 `launchctl` 中会改变系统状态或无法识别的子命令。`status`、`show`、`list` 等已知只读查询不要求确认。
- `kubectl apply`、`kubectl delete`、`terraform apply`、`terraform destroy`、`docker rm`、`docker prune` 和 `docker container rm`。
- `eval`、动态命令、动态 Shell `-c` 子脚本和无法可靠解析的 Shell 输入。
- 写入明显系统路径的 Bash 重定向。
- 写入明显系统路径的 `write` 或 `edit` 调用。默认路径包括 `/etc/**`、`/usr/**`、`/bin/**`、`/sbin/**`、`/System/**`、`/Library/**` 和 `/var/**`。
- 通过 `write` 或 `edit` 修改当前分支已加载的 `skill://` 技能路径。审批目标保留逻辑路径，不暴露技能的真实目录。
- `webfetch` 访问解析到 localhost、私网地址或其他非公网地址的 origin。

## 默认无需确认

- 普通 `bash` 命令，例如输出、测试、构建和格式化命令。
- 已证明只影响 `mktemp` 创建的一次性文件或目录，或者系统临时目录后代的写入和本地清理。
- 针对普通项目文件的 `write` 和 `edit` 调用。技能逻辑路径除外。
- `read`、`ls`、`find` 和 `grep`。
- 只解析到公网地址或已配置 fake-ip 的 `webfetch` 调用。
- LSP 和 subagent。

## 配置

默认配置位于 `agent/defaults/approval-gate.jsonc`，用户覆盖配置位于 `agent/configs/approval-gate.jsonc`，JSON Schema 位于 `agent/schemas/approval-gate.schema.json`。Approval Gate 只读取用户全局覆盖配置，不读取项目配置。分层规则见[配置分层](configuration.md)。

关键字段：

- `enabled`：总开关。设为 `false` 时，Bash、Write、Edit 和 WebFetch 的 `allow`、`ask` 和 `deny` 调用策略都会被跳过。工具自身的运行约束仍然生效，因此未获批准的私网请求仍会被 `webfetch` 拒绝。
- `ui.timeout_ms`：交互超时时间，单位为毫秒。`0` 表示不超时。TUI 审批面板显示剩余时间并在到期后拒绝调用。RPC 选择框和拒绝指令输入框使用 Pi UI 的超时机制。
- `ui.non_interactive`：没有交互式界面时使用 `block` 或 `allow`，默认为 `block`。
- `tools.bash.default_action`：Bash 未命中安全事实或路径规则时使用的 `allow`、`ask` 或 `deny`。
- `tools.bash.facts`：Bash 安全事实及其命令分类正则。
- `tools.bash.combinations`：多个 Bash 安全事实同时出现时使用的升级决策。
- `tools.write.default_action` 和 `tools.edit.default_action`：文件写入未命中路径规则时使用的默认动作。
- `tools.webfetch.default_action`：私网 origin 未命中已记住的放行规则时使用的默认动作，默认为 `ask`。
- `ask_rules`：命中后要求用户确认。
- `deny_rules`：用户定义的拒绝规则。命中后不显示审批界面。
- `remember.allow_session`：是否显示 `Allow for session`。
- `remember.allow_persistent`：是否显示 `Always allow similar`。
- `remember.persistent_store`：持久放行规则文件。默认值为 `~/.pi/agent/state/approval-gate.rules.jsonc`。

Bash 策略位于 Approval Gate 配置的 `tools.bash` 中。`facts` 以事实 ID 为键。每个事实包含可选的 `ask` 或 `deny` 动作，以及一组带名称的命令分类器。字符串分类器默认匹配 Tree-sitter 提取的单条命令原文，并在所有平台生效。对象分类器还可以用 `scope` 选择 `raw-input`、`source-unit` 或 `effective-unit`，并用 `platform` 限制平台。

`combinations` 在一次 Bash 调用同时产生指定事实时升级决策。判定优先级固定为 `deny`、`ask`、`default_action`。已记住的批准不能覆盖 `deny`。用户配置按事实 ID 和分类器 ID 递归合并。分类器可设为 `false`，事实可使用 `enabled: false`，组合可设为 `false`。

`/approval-check <bash command>` 使用相同配置解析命令，但不执行命令。该命令显示最终决策、产生的事实、命中的分类器和事实组合。

`ask_rules` 和 `deny_rules` 处理路径审批。路径规则示例：

```jsonc
{
	"name": "system-path-write",
	"tools": ["bash", "write", "edit"],
	"path_globs": ["/etc/**", "/usr/**", "/System/**"],
	"reason": "system path modification"
}
```

`path_globs` 只匹配路径审批单元，包括 `write`、`edit` 和 Bash 中可静态解析的文件写重定向。匹配前，目标会转换为使用 `/` 的绝对路径，因此 glob 也应覆盖绝对路径。如果不限定根目录，可以使用 `**/name/**`。数组中任一 glob 命中即视为匹配，空数组不是合法配置。`picomatch` 解释这些 glob。`*` 匹配单个路径段内的字符，`**` 可以跨路径段，隐藏路径也参与匹配。开头的 `!` 按普通字符处理，不表示排除规则。

`path_globs` 只检查路径审批单元，不解析普通命令参数。例如，`rm /etc/file` 应通过 Bash 安全事实分类器匹配。未配置 `path_globs` 时，规则只按工具名匹配。

## 用户选择

- `Allow once`：只放行当前工具调用。
- `Allow for session`：只记住本次实际触发确认的敏感子命令、路径或私网 origin，不记住普通同级单元。Bash 命令规则还会绑定当前 `cwd`。
- `Always allow similar`：为每个敏感单元写入持久放行规则。特定的软件包安装命令会生成保守前缀，例如 `npm install`。`git push` 等其他命令使用完整命令，不生成宽泛前缀。路径目标是 `/etc/nginx` 的直接子项时生成 `/etc/nginx/**`，其他路径使用精确值。私网请求只记住完整 origin。Bash 命令规则还会绑定创建规则时的 `cwd`。
- `Deny`：拒绝当前工具调用，并返回 `User denied this tool call.`。
- `Deny with instruction`：拒绝当前工具调用，并通过 `reason` 把用户指令返回给代理：

```text
User denied this tool call.

Instruction from user:
...
```

如果任一待确认单元无法生成范围明确的规则，对应的记忆选项就不会显示。持久规则文件不使用版本号，Approval Gate 根据规则字段解析文件。每条规则包含 `tool`、`kind` 和 `value`。`exact_command` 和 `command_prefix` 规则还必须包含 `cwd`，并且只匹配相同工作目录。`exact_path` 和 `path_glob` 规则不接受 `cwd`。额外字段不影响解析，无法识别的规则不会加载。

```jsonc
{
	"rules": [
		{
			"tool": "bash",
			"kind": "exact_command",
			"value": "git push origin main",
			"cwd": "/workspace/project"
		},
		{
			"tool": "edit",
			"kind": "exact_path",
			"value": "/etc/hosts"
		}
	]
}
```

## 非交互模式

需要审批但没有支持对话框的界面时，默认执行 `block`：

```text
Approval required but no interactive UI is available: ...
```

可以把 `ui.non_interactive` 改为 `allow`，但该设置会跳过所有 `ask` 类确认。
