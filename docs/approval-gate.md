# Approval Gate

`approval-gate` 是轻量确认层：工具调用安全上可以执行，但可能有明显副作用时，先问用户是否继续。它不是 sandbox、workspace 权限系统或安全边界。

执行顺序：

```text
tool_call hook
optional safety precheck
approval policy
approval UI
execute or block
```

审批拒绝通过 `{ block: true, reason }` 返回，不调用 `ctx.abort()`。

## 和 safety guardrail 的区别

Safety guardrail 负责硬性拒绝明显危险操作，例如 bash deny pattern、file-tools blocked path。Approval gate 只处理用户意图确认，例如发布、安装包、改系统路径。

当前实现会在审批前轻量复用已有 helper：

- `bash`：命中 bash-tool `safety.deny_patterns` / `deny_regex` 时直接 block。
- `write` / `edit`：命中 file-tools `blocked_path` 时直接 block。

这些 precheck 只用于避免询问必然会被工具拒绝的请求；最终安全边界仍在原工具内部。

## 默认会询问

- `git push`、`npm publish`、`gh release`、`twine upload`。
- `npm/pnpm/pip/uv/cargo/brew/apt/dnf/yum/pacman install/remove/update/upgrade`。
- `sudo`、`systemctl`、`service`、`launchctl`。
- `rm -rf`、`git reset --hard`、`git clean -fd`、`docker system prune`。
- `kubectl apply/delete`、`terraform apply/destroy`、部分 `docker rm/prune`。
- `write` / `edit` 明显系统路径：`/etc/**`、`/usr/**`、`/bin/**`、`/sbin/**`、`/System/**`、`/Library/**`、`/var/**`。

## 默认不会询问

- 普通 `bash` 命令，例如 `echo`、测试、构建、格式化。
- 普通项目文件的 `write` / `edit`。
- `read`、`ls`、`find`、`grep`。
- `webfetch`、LSP、subagent。

## 配置

配置文件：`agent/configs/approval-gate.jsonc`，schema：`agent/schemas/approval-gate.schema.json`。

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
	"command_regex": "\\b(git\\s+push|npm\\s+publish)\\b",
	"effects": ["publish"],
	"reason": "external publishing"
}
```

`tools` 必须匹配；`path_globs`、`command_regex`、`effects` 写了就必须匹配。没有写这些 matcher 时，只按工具名匹配。

## 用户选择

- `Allow once`：只放行当前工具调用。
- `Allow for session`：本会话记住当前精确命令或精确路径。
- `Always allow similar`：写入持久规则。bash 默认优先生成保守前缀规则，例如 `git push`、`npm install`；其他命令用完整命令。文件路径只对明确目录生成窄 `path_glob`，否则用精确路径。
- `Deny`：拒绝当前工具调用，返回 `User denied this tool call.`。
- `Deny with instruction`：拒绝并通过 reason 把用户指令返回给 agent：

```text
User denied this tool call.

Instruction from user:
...
```

## 非交互模式

需要审批但没有 dialog-capable UI 时，默认 block：

```text
Approval required but no interactive UI is available: ...
```

可把 `ui.non_interactive` 改成 `allow`，但这会跳过所有 ask 类确认。
