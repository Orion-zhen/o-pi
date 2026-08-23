# Approval Gate 审批机制

`approval-gate` 在工具调用执行前确认用户意图。安全策略允许工具调用，但审批策略要求确认时，Approval Gate 会询问用户是否继续。Approval Gate 不是沙箱、工作区权限系统或安全边界。

执行顺序：

1. 进入 `tool_call` 钩子。
2. 执行可选的安全预检查。
3. 使用 Tree-sitter 解析 Bash。
4. 评估审批策略。
5. 显示审批界面。
6. 执行或阻止工具调用。

审批策略判定为 `ask` 且存在交互式界面时，Approval Gate 会先尝试发送系统通知，再显示审批选择框。通知失败不影响审批。用户拒绝后，Approval Gate 返回 `{ block: true, reason }`，但不调用 `ctx.abort()`。

`ApprovalGate` 仅通过 `ApprovalInteractionPort` 的 `select`、`input` 和 `notify` 方法访问交互界面，不依赖 Pi TUI。当前扩展在 `ctx.hasUI` 为 `true` 时通过 Pi UI 注入该端口。JSON 模式和打印模式没有该端口，因此使用 `ui.non_interactive` 策略。对话框文本和选项属于适配器的展示内容，不是未来图形界面的状态协议。

`createApprovalGate` 支持可选的 `telemetry` 观察器。观察器接收审批结果、规则名和等待时间，但不接收 `reason` 文本。观察器失败不影响审批或工具执行。当前扩展没有注入观察器，因此默认运行路径不记录审批遥测。

## 与安全防护机制的区别

安全防护机制强制拒绝危险操作，例如命中 Bash 拒绝规则或文件工具的受阻路径。Approval Gate 只确认用户意图，例如发布软件、安装软件包或修改系统路径。

Approval Gate 会在审批前复用以下检查：

- `bash`：命中 `bash-tool` 的 `safety.deny_patterns` 或 `deny_regex` 时直接阻止。
- `write` 或 `edit`：命中文件工具的 `blocked_path` 时直接阻止。

这些预检查用于避免询问必然会被工具拒绝的请求。最终安全边界仍由原工具实现。

## Bash 解析与审批单元

共享语法解析层使用 `tree-sitter-bash` 的 WASM 语法解析 `bash` 输入。C、C++、Go、JavaScript/JSX、TypeScript/TSX、Python、Rust 和 Bash 共用 `web-tree-sitter` 运行时、语言目录和解析器缓存。Bash 注册项还允许代码索引自动识别并解析 `.sh` 文件。

Approval Gate 不把整段 Shell 文本作为一个审批目标，而是提取以下单元：

- 管道、`&&`、`||` 和 `;` 等结构中的简单命令。
- 命令替换和进程替换中的嵌套命令。
- 可静态确定的 `bash`、`sh` 和 `zsh` 等 Shell 的 `-c` 参数中的子脚本。
- `>`、`>>`、`>|`、`&>` 和 `&>>` 等文件写重定向。`2>&1` 等文件描述符复制不属于文件写入。
- 具有有限字面量取值的 `for` 循环中的命令变量。例如，`for engine in xelatex lualatex` 会产生两个具体命令供分析。

审批策略逐单元评估，但一次工具调用只显示一个聚合审批框。显式 `deny_rules` 的优先级高于已记住的放行规则。任何单元被拒绝都会阻止整段原始命令。审批框会汇总未被放行规则覆盖且需要确认的单元。用户批准后，工具仍执行原始完整命令。

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

## 默认无需确认

- 普通 `bash` 命令，例如输出、测试、构建和格式化命令。
- 已证明只影响 `mktemp` 创建的一次性文件或目录，或者系统临时目录后代的写入和本地清理。
- 针对普通项目文件的 `write` 和 `edit` 调用。
- `read`、`ls`、`find` 和 `grep`。
- `webfetch`、LSP 和 subagent。

## 配置

默认配置位于 `agent/defaults/approval-gate.jsonc`，用户覆盖配置位于 `agent/configs/approval-gate.jsonc`，JSON Schema 位于 `agent/schemas/approval-gate.schema.json`。Approval Gate 只读取用户全局覆盖配置，不读取项目配置。分层规则见[配置分层](configuration.md)。

关键字段：

- `enabled`：总开关。
- `ui.timeout_ms`：交互超时时间，单位为毫秒。`0` 表示不超时。大于 `0` 时，该值会传给 Pi UI 的 `select` 和 `input` 调用。
- `ui.non_interactive`：没有交互式界面时使用 `block` 或 `allow`，默认为 `block`。
- `defaults`：未命中规则时，按工具使用默认的 `allow`、`ask` 或 `deny` 策略。
- `ask_rules`：命中后要求用户确认。
- `deny_rules`：用户定义的拒绝规则。命中后不显示审批界面。
- `remember.allow_session`：是否显示 `Allow for session`。
- `remember.allow_persistent`：是否显示 `Always allow similar`。
- `remember.persistent_store`：持久放行规则文件。默认值为 `~/.pi/agent/state/approval-gate.rules.jsonc`。

规则示例：

```jsonc
{
	"name": "external-publish",
	"tools": ["bash"],
	"command_regex": "^(?:git\\b.*\\spush|npm\\s+publish)\\b",
	"reason": "external publishing"
}
```

路径规则示例：

```jsonc
{
	"name": "system-path-write",
	"tools": ["bash", "write", "edit"],
	"path_globs": ["/etc/**", "/usr/**", "/System/**"],
	"reason": "system path modification"
}
```

`path_globs` 只匹配路径审批单元，包括 `write`、`edit` 和 Bash 中可静态解析的文件写重定向。匹配前，目标会转换为使用 `/` 的绝对路径，因此 glob 也应覆盖绝对路径。如果不限定根目录，可以使用 `**/name/**`。数组中任一 glob 命中即视为匹配。`picomatch` 解释这些 glob。`*` 匹配单个路径段内的字符，`**` 可以跨路径段，隐藏路径也参与匹配。开头的 `!` 按普通字符处理，不表示排除规则。

`path_globs` 不解析普通命令参数。例如，`rm /etc/file` 是命令单元，应使用 `command_regex`。不要在同一条规则中同时配置 `path_globs` 和 `command_regex`。两个匹配条件使用逻辑与关系，而单个审批单元只能是路径单元或命令单元，因此同时配置时规则无法命中。

`tools` 必须匹配。配置 `path_globs` 或 `command_regex` 后，对应条件也必须匹配。未配置这两个条件时，规则只按工具名匹配。对于 Bash，`command_regex` 应用于单个抽象语法树审批单元，而不是整段复合命令。匹配器会依次检查直接命令视图，以及移除 `env` 和 `command` 等透明包装命令后的视图。默认敏感命令只在 `command_regex` 中维护，没有独立的命令语义分类表。

## 用户选择

- `Allow once`：只放行当前工具调用。
- `Allow for session`：只记住本次实际触发确认的敏感子命令或路径，不记住普通同级单元。Bash 命令规则还会绑定当前 `cwd`。
- `Always allow similar`：为每个敏感单元写入持久放行规则。特定的软件包安装命令会生成保守前缀，例如 `npm install`。`git push` 等其他命令使用完整命令，不生成宽泛前缀。路径目标是 `/etc/nginx` 的直接子项时生成 `/etc/nginx/**`，其他路径使用精确值。Bash 命令规则还会绑定创建规则时的 `cwd`。
- `Deny`：拒绝当前工具调用，并返回 `User denied this tool call.`。
- `Deny with instruction`：拒绝当前工具调用，并通过 `reason` 把用户指令返回给代理：

```text
User denied this tool call.

Instruction from user:
...
```

如果任一待确认单元无法生成范围明确的规则，对应的记忆选项就不会显示。持久规则文件使用 `version: 1`。新建的 Bash 命令规则包含可选的 `cwd` 字段。读取没有 `cwd` 字段的旧规则时，Approval Gate 继续将旧规则作为全局规则使用。

## 非交互模式

需要审批但没有支持对话框的界面时，默认执行 `block`：

```text
Approval required but no interactive UI is available: ...
```

可以把 `ui.non_interactive` 改为 `allow`，但该设置会跳过所有 `ask` 类确认。
