# Approval Gate

`approval-gate` 是轻量确认层：工具调用安全上可以执行，但可能有明显副作用时，先问用户是否继续。它不是 sandbox、workspace 权限系统或安全边界。

执行顺序：

```text
tool_call hook
optional safety precheck
Tree-sitter Bash parsing
approval policy
approval UI
execute or block
```

策略返回 `ask` 且交互 UI 可用时，Gate 会先尽力发送系统通知，再打开审批选择框；通知失败不影响审批。审批拒绝通过 `{ block: true, reason }` 返回，不调用 `ctx.abort()`。

Gate 会把 allow/ask/deny、具体 UI 选择、规则名和等待时间直接附加到当前 Pi `TelemetryService` 的 pending call，最终随该调用唯一的 `call` record 落盘。遥测不解析 `reason` 文本，也不会写入 session tree；采集失败不影响审批或工具执行。

## 和 safety guardrail 的区别

Safety guardrail 负责硬性拒绝明显危险操作，例如 bash deny pattern、file-tools blocked path。Approval gate 只处理用户意图确认，例如发布、安装包、改系统路径。

当前实现会在审批前轻量复用已有 helper：

- `bash`：命中 bash-tool `safety.deny_patterns` / `deny_regex` 时直接 block。
- `write` / `edit`：命中 file-tools `blocked_path` 时直接 block。

这些 precheck 只用于避免询问必然会被工具拒绝的请求；最终安全边界仍在原工具内部。

## Bash 解析与审批单元

`bash` 输入通过共享语法解析层中的 `tree-sitter-bash` WASM grammar 解析。C、C++、Go、JavaScript/JSX、TypeScript/TSX、Python、Rust 和 Bash 共用同一套 `web-tree-sitter` runtime、语言 catalog 与 parser cache；同一 Bash 注册项也让 code-index 自动识别并解析 `.sh` 文件。

Gate 不再把整段 shell 文本当成一个批准目标，而是提取：

- pipeline、`&&`、`||`、`;` 等结构中的简单命令。
- command substitution、process substitution 中的嵌套命令。
- 字面量 `bash` / `sh` / `zsh` 等 `-c` 参数中的子脚本。
- `>`、`>>`、`>|`、`&>`、`&>>` 等文件写重定向；`2>&1` 这类 fd duplication 不算文件写入。

策略逐单元执行，但一次工具调用只显示一个聚合审批框。显式 `deny_rules` 先于 remembered allow；任何单元被 deny 都会阻止整次原始命令。未被记忆规则覆盖且需要确认的单元会一起显示，批准后仍执行原始完整命令。

语法错误、grammar/runtime 不可用、分析超时、嵌套过深或单元过多时，Gate 把整段输入降级为不可持久化的 opaque 单元；其策略匹配视图以 `<opaque>` 开头。动态命令名使用 `<dynamic>` 占位，无法静态解析的 `shell -c` 也不可持久化。动态写重定向无法生成安全规则时只提供一次性批准。

## 默认会询问

- `git push`、`npm publish`、会修改 release 的 `gh release` 子命令、`twine upload`。
- `npm/pnpm/pip/uv/cargo/brew/apt/dnf/yum/pacman install/remove/update/upgrade`。
- `sudo`、`systemctl`、`service`、`launchctl`。
- `rm -rf`、`git reset --hard`、`git clean -fd`、`docker system prune`。
- `kubectl apply/delete`、`terraform apply/destroy`、部分 `docker rm/prune`。
- 动态命令、动态 `shell -c` 和无法可靠解析的 shell 输入。
- Bash 写重定向到明显系统路径。
- `write` / `edit` 明显系统路径：`/etc/**`、`/usr/**`、`/bin/**`、`/sbin/**`、`/System/**`、`/Library/**`、`/var/**`。

## 默认不会询问

- 普通 `bash` 命令，例如 `echo`、测试、构建、格式化。
- 普通项目文件的 `write` / `edit`。
- `read`、`ls`、`find`、`grep`。
- `webfetch`、LSP、subagent。

## 配置

默认配置位于 `agent/defaults/approval-gate.jsonc`，用户覆盖位于 `agent/configs/approval-gate.jsonc`，schema 为 `agent/schemas/approval-gate.schema.json`。该配置只允许用户全局覆盖，不读取项目配置。分层规则见[配置分层](configuration.md)。

关键字段：

- `enabled`：总开关。
- `ui.timeout_ms`：`0` 表示不超时；大于 `0` 时传给 Pi UI dialog。
- `ui.non_interactive`：无交互 UI 时 `block` 或 `allow`，默认 `block`。
- `defaults`：未命中规则时按工具默认 `allow` / `ask` / `deny`。
- `ask_rules`：命中后询问用户。
- `deny_rules`：用户配置的偏好拒绝，命中后不弹 UI。
- `remember.allow_session`：显示 `Allow for session`。
- `remember.allow_persistent`：显示 `Always allow similar`。
- `remember.persistent_store`：持久规则文件，默认 `~/.pi/agent/state/approval-gate.rules.jsonc`。

规则字段：

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

`path_globs` 只匹配路径审批单元，包括 `write`、`edit` 和 Bash 中可静态解析的文件写重定向。目标在匹配前会转换为使用 `/` 的绝对路径，因此 pattern 也应覆盖绝对路径；若不限定根目录，可使用 `**/name/**`。数组中任意一个 glob 命中即视为匹配。glob 由 `picomatch` 解释：`*` 匹配单个路径段内的字符，`**` 可以跨路径段，隐藏路径也参与匹配，开头的 `!` 按普通字符处理而不是排除规则。

`path_globs` 不解析普通命令参数；例如 `rm /etc/file` 是命令单元，应使用 `command_regex`。不要在同一条规则中同时配置 `path_globs` 和 `command_regex`：matcher 之间是 AND 关系，而单个审批单元只会是路径或命令中的一种，因此这样的规则无法命中。

`tools` 必须匹配；`path_globs`、`command_regex` 写了就必须匹配。没有写 matcher 时，只按工具名匹配。对 Bash，`command_regex` 应用于单个 AST 审批单元，而不是整段复合命令；它会依次检查直接命令视图和移除 `env`、`command` 等透明 wrapper 后的视图。默认敏感命令只在 `command_regex` 中维护，不存在独立的命令语义分类表。

## 用户选择

- `Allow once`：只放行当前工具调用。
- `Allow for session`：只记住本次实际触发确认的敏感子命令或路径，不记住普通 sibling。Bash 命令规则同时绑定当前 `cwd`。
- `Always allow similar`：为每个敏感单元写入持久规则。只有明确的包安装命令生成保守前缀，例如 `npm install`；`git push` 等使用完整子命令，不生成宽前缀。文件路径只对明确目录生成窄 `path_glob`，否则使用精确路径。Bash 命令规则绑定创建时的 `cwd`。
- `Deny`：拒绝当前工具调用，返回 `User denied this tool call.`。
- `Deny with instruction`：拒绝并通过 reason 把用户指令返回给 agent：

```text
User denied this tool call.

Instruction from user:
...
```

当某个敏感单元无法生成覆盖范围明确的规则时，相应 remembered 选项不会显示。持久规则文件仍为 version 1；新 Bash 命令规则带可选 `cwd` 字段，旧规则没有该字段时继续按全局规则读取。

## 非交互模式

需要审批但没有 dialog-capable UI 时，默认 block：

```text
Approval required but no interactive UI is available: ...
```

可把 `ui.non_interactive` 改成 `allow`，但这会跳过所有 ask 类确认。
