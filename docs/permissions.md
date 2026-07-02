# 权限系统

本权限系统是 Pi 应用层授权，不是 OS sandbox。批准只表示 Pi 可以尝试执行；进程仍受当前用户的系统权限限制，系统仍可能返回 `EACCES` 或 `EPERM`。真正不可信任务仍建议在容器或 VM 中运行。

## 模型

策略文件直接使用工具名：`ls`、`read`、`edit`。内部仍把调用转换成文件动作，用于审计、风险判断和执行前重验证；用户不需要在配置里写 `fs.*`。

每个路径都会解析为 absolute path 和 canonical real path。已有路径使用 `lstat -> realpath`；不存在创建目标使用最近存在父目录的 realpath，并记录父目录 identity。授权后、实际 I/O 前会重新验证 canonical path、identity、类型和父目录状态。

边界：

* `workspace`：canonical path 在当前 workspace 内。
* `external`：workspace 外普通用户路径。
* `system`：系统管理路径。
* `sensitive`：凭据、`.git`、Pi 认证/信任数据、权限策略和权限系统文件。

默认策略：

* workspace：`ls/read/edit` 允许。
* external：`ls/read/edit` 询问。
* system：`ls/read` 询问，`edit` 拒绝。
* sensitive：全部拒绝，不能被 yolo、项目策略或普通批准覆盖。

## 配置

全局策略：`${getAgentDir()}/pi-permissions.jsonc`。

项目策略：`<workspace>/.pi/permissions.jsonc`，只在 `ctx.isProjectTrusted()` 为真时加载。项目策略可以收紧全局策略，或把全局普通 ask 的精确路径改为 allow；不能解除全局 deny。

schema：`agent/permissions.schema.json`。

示例：

```jsonc
{
	"$schema": "./permissions.schema.json",
	"version": 1,
	"defaults": {
		"workspace": { "ls": "allow", "read": "allow", "edit": "allow" },
		"external": { "*": "ask" },
		"system": { "ls": "ask", "read": "ask", "edit": "deny" },
		"sensitive": { "*": "deny" }
	},
	"rules": [
		{
			"id": "allow-work-dir",
			"effect": "allow",
			"tools": ["ls", "read"],
			"resource": { "type": "path", "path": "~/Documents/pi-work", "scope": "subtree" }
		},
		{
			"id": "deny-ssh",
			"effect": "deny",
			"tools": ["*"],
			"resource": { "type": "path", "path": "~/.ssh", "scope": "subtree" }
		}
	]
}
```

## 交互授权

策略为 `ask` 且有 UI 时，Pi 显示授权选择：

* Allow once：绑定当前 toolCallId、fingerprint、policy generation 和完整访问集合，调用结束失效。
* Allow exact path for session：当前会话、精确 canonical path、精确动作。
* Allow directory for session：当前会话、目录 subtree、当前工具动作；`ls` 会同时授予后续 `read`。
* Deny：同一 fingerprint 短期内不会重复弹窗。

无 UI 时，`ask` 返回 `PERMISSION_PROMPT_UNAVAILABLE`，不会自动允许。自动化场景应预配置精确 allow 规则。

## 模式

`safe`：正常执行 allow/ask/deny。

`read-only`：写动作全部拒绝。

`yolo`：普通 ask 视为 allow，但不能覆盖 hard deny、全局 deny、项目 deny、sensitive、自我保护或 OS 错误。

## 命令

```text
/permissions
/permissions status
/permissions explain <ls|read|edit> <path>
/permissions grants
/permissions revoke <grant-id>
/permissions revoke-all
/permissions reload
/permissions validate
/permissions edit global
/permissions edit project
/permissions mode safe
/permissions mode read-only
/permissions mode yolo
```

`/permissions edit` 只打开可信编辑说明，不通过普通 `edit` 修改策略。

## ignore 边界

ignore 与 permission 分离：

* ignore 决定路径是否参与自动发现、遍历、搜索或索引。
* permission 决定工具是否能对路径执行动作。

soft ignored 文件仍可按权限显式 `read` 或 `edit`；`.piignore` 和 `.gitignore` 不能授予或拒绝权限。

## 审计

审计为 JSONL，可配置路径，默认关闭。记录 request id、toolCallId、toolName、fingerprint、policy generation、动作、canonical path、boundary、策略结果和最终决定。不记录文件内容、完整 diff、环境变量或密钥。

## 当前覆盖

当前强制接入 `ls/read/edit`。第三方工具、内置 shell、外部 MCP 或其他扩展的文件 I/O 只有在它们主动调用本权限服务时才受控。
