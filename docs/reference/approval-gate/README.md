# 审批

Approval Gate 在 `tool_call` 中检查 Bash、write、edit 和 webfetch，返回 allow、ask 或 deny。工具获准后仍按自身路径、版本和网络规则执行。

## 默认行为

以下操作通常需要确认：

- 删除、强制清理或重置。
- 安装、删除和更新软件包。
- 推送、发布和创建发布版本。
- 提权与修改系统状态。
- 部署、删除容器和基础设施变更。
- 动态或无法可靠解析的 Shell 输入。
- 写入系统路径或已加载的技能文件。
- webfetch 访问私网 origin。

普通项目读写、查询、测试和构建通常直接执行。可静态证明只影响临时目录的写入和清理可豁免确认，显式拒绝规则仍优先。

完整分类器与默认值见 [`approval-gate.jsonc`](../../../agent/defaults/approval-gate.jsonc)。

## 选择

| 操作 | 效果 |
| --- | --- |
| Allow once | 放行当前调用 |
| Allow for session | 记住当前敏感单元 |
| Always allow similar | 保存范围明确的持久规则 |
| Deny | 拒绝调用 |
| Deny with instruction | 拒绝并把附加指令返回给代理 |

Bash 放行绑定当前工作目录。私网放行绑定完整 origin。动态目标无法生成明确规则时，只显示可用的记忆选项。

TUI 的方向键选择操作，PageUp/PageDown 浏览内容，Enter 确认，Esc 或 Ctrl+C 拒绝。GUI 展示结构化命令、敏感单元和文件内容，RPC 使用选择与输入接口。

审批扩展发出请求和完成事件，前端据此发送[系统通知](../runtime/notifications.md)。

## 配置

用户文件为 `~/.pi/agent/configs/approval-gate.jsonc`，可用 `PI_APPROVAL_GATE_CONFIG` 指定路径。

| 字段 | 含义 |
| --- | --- |
| `enabled` | 总开关 |
| `ui.timeout_ms` | 确认超时，0 表示不限时 |
| `ui.non_interactive` | 无界面时 block 或 allow，默认 block |
| `tools.<tool>.default_action` | 未命中规则时的动作 |
| `tools.bash.facts` | Bash 事实与分类器 |
| `tools.bash.combinations` | 事实组合的升级决策 |
| `ask_rules`、`deny_rules` | 路径和工具规则 |
| `remember.allow_session` | 会话放行选项 |
| `remember.allow_persistent` | 持久放行选项 |
| `remember.persistent_store` | 规则文件路径 |

关闭总开关会跳过调用策略。需要不可绕过的权限隔离时，在进程外使用低权限账号或沙箱。

## 检查与专题

```text
/approval-check git push origin main
```

命令显示配置策略、事实、分类器和组合，解析但不执行 Shell。

[Bash 分析与规则](rules.md)记录解析、临时范围、路径匹配和持久存储。实现位于 `src/harness/approval/`，Pi 入口为 `src/harness/extensions/approval-gate.ts`。
