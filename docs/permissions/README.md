# 安全授权模型

本仓库隔离两层模型：

```text
用户配置模型 -> PolicyCompiler -> 内部形式化授权模型
```

用户只配置 catalog 中可见的工具、Bash、MCP、Skill、Agent 名称、路径和四种模式：`off`、`allow`、`ask`、`always-ask`。内部仍使用原子授权、组件身份、不可变 ticket、审批 grant、delegation 和审计，但这些不是用户配置 API。

核心规则：

* catalog 是配置名称唯一来源，未知名称直接报错并给出拼写建议。
* 限制强度固定为 `allow < ask < always-ask < off`。
* global、Agent、路径和 delegation 取最严格结果，规则顺序不产生覆盖语义。
* `allow` 不弹审批，但仍必须通过内部边界、显式拒绝、delegation 和原子资源检查。
* `ask` 可使用一次、会话或永久审批记录。
* `always-ask` 每次审批，只生成本次执行 ticket。
* `off` 不暴露且禁止执行，直接绕过 catalog 调用也会被拒绝。

配置文件是 `~/.pi/agent/permissions.jsonc` 和 `<workspace>/.pi/permissions.jsonc`。项目配置只能收紧，不能把 `off`、`always-ask` 或 `ask` 放宽。

无 OS 沙箱限制：本系统控制 Pi 入口与本仓库文件工具；一旦允许 Bash 或外部进程运行，子进程仍拥有当前操作系统用户权限。
