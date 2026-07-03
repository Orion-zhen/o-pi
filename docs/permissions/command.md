# `/permissions`

```text
/permissions
/permissions catalog
/permissions explain agent reviewer tool read path ./src/a.ts
/permissions explain agent main mcp github/create_issue
/permissions explain agent main subagent reviewer
/permissions set global tool bash always-ask
/permissions set agent reviewer tool edit off
/permissions set global mcp github/create_issue ask
/permissions set global skill code-review allow
/permissions set global subagent reviewer ask
/permissions schema
```

`/permissions` 显示项目 trust 状态和当前可配置项数量，不显示内部授权 ID。

`/permissions catalog` 只显示用户可写名称：

```text
Tools
  ls
  read
  edit
  bash

MCP
  github/get_issue

Skills
  code-review

Agents
  main
```

`/permissions explain` 输出用户可理解的合并链，例如：

```text
结果：需要审批

全局 edit = allow
Agent implementer edit = ask
路径 ${workspace}/src/**：ask
最终模式：ask
```

`/permissions set` 通过 JSONC 事务服务修改 `permissions.jsonc`，保留注释和无关格式。命令只接受公开名称和 `off|allow|ask|always-ask`。

`/permissions schema` 根据当前 catalog 生成 `permissions.schema.json`，用于编辑器补全当前可配置名称。
