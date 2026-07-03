# 配置

`permissions.jsonc` 只使用用户可见名称和四种模式：

```text
off <禁止且不暴露>
allow <允许，不询问>
ask <无审批记录时询问>
always-ask <每次询问，只允许本次>
```

限制强度：`allow < ask < always-ask < off`。global、Agent、路径和 delegation 取最严格结果，数组顺序不表示优先级。

```jsonc
{
	"$schema": "./permissions.schema.json",
	"version": 1,
	"global": {
		"tools": {
			"ls": "allow",
			"read": "allow",
			"edit": "ask",
			"bash": "always-ask",
			"*": "off"
		},
		"mcp": {
			"github": {
				"get_issue": "allow",
				"create_issue": "ask",
				"*": "off"
			},
			"*": "off"
		},
		"skills": {
			"code-review": "allow",
			"*": "off"
		},
		"subagents": {
			"reviewer": "ask",
			"*": "off"
		}
	},
	"agents": {
		"reviewer": {
			"tools": {
				"ls": "allow",
				"read": "allow",
				"edit": "off",
				"bash": "off",
				"*": "off"
			},
			"mcp": { "*": "off" },
			"skills": {
				"code-review": "allow",
				"*": "off"
			},
			"subagents": { "*": "off" }
		}
	},
	"paths": [
		{
			"match": "${workspace}/src/**",
			"agents": {
				"main": {
					"tools": {
						"read": "allow",
						"edit": "ask",
						"bash": "always-ask"
					}
				},
				"reviewer": {
					"tools": {
						"read": "allow",
						"edit": "off",
						"bash": "off"
					}
				}
			}
		},
		{
			"outsideWorkspace": true,
			"agents": {
				"*": {
					"tools": {
						"read": "ask",
						"edit": "always-ask",
						"bash": "always-ask"
					}
				}
			}
		}
	],
	"approval": {
		"ask": { "remember": ["once", "session", "persistent"] },
		"always-ask": { "remember": ["once"] }
	},
	"audit": { "enabled": true }
}
```

字段：

* `global`: 全局可用组件模式。
* `agents`: 指定 Agent 的收紧规则；省略字段继承 global。
* `paths`: 按路径和 Agent 收紧组件模式；多条匹配规则取最严格值。
* `mcp`: 固定为 `server -> tool` 两级名称。
* `subagents`: 当前 Agent 可以启动哪些 Agent。
* `approval`: 限制 `ask` 和 `always-ask` 可创建的审批记忆范围。

路径变量在编译阶段展开：`${workspace}`、`${agentDir}`、`~`。`outsideWorkspace: true` 表示 canonical path 不在当前 workspace 内。

配置文件不能包含内部授权名、资源 URI、principal pattern 或 digest。组件实现变化后，用户配置仍按可见名称重新绑定；旧审批记录会暂停，旧执行 ticket 会失效。
