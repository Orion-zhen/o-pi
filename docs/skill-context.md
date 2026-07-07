# Skill Context

`skill-context` 用 host-managed selected context 替换 Pi 默认 `/skill:name` 展开流程。

## 行为

- `/skill:<name>` 由 extension host 直接读取对应 `SKILL.md`，写入 session custom entry。
- 扩展不重复注册每个 `/skill:<name>`；命令列表使用 Pi 内置 skill 项，执行由 input hook 接管。
- 加载/卸载状态显示为 skill 状态卡片；卡片不启动模型、不产生 assistant message、不触发 read 工具。
- 下一次真实用户请求前，context hook 按 session 时间线注入 `<skill name="..." status="active">` user-role synthetic message。
- skill body 不进入 system prompt；扫描到 skill 时 `/system` 只显示 `<skill_policy>`，不显示 skill name、path 或 description。
- 模型尝试 read 已加载 skill 的 `SKILL.md` 时会被阻止；需要读取引用文件时读取 reference 文件。

## 清理

`/skill clear` 默认 lazy deactivate：

- 单个 skill 追加 `<skill name="..." status="inactive"/>`；`--all` 追加 `<skill status="previous all inactive"/>`。
- 保留旧 active skill body，保护 llama.cpp / prompt cache 的稳定前缀。
- 后续模型应知道该 skill inactive，不再应用。

`/skill clear --hard`：

- 允许后续上下文物理省略旧 skill body。
- 不注入 inactive tag，减少后续上下文 token。
- 下一轮可能降低 prompt cache 命中。
- 适合确认不再需要该 skill 或准备压缩上下文时使用。

## 命令

```text
/skill:<name>
/skill
/skill clear
/skill clear <name>
/skill clear --all
/skill clear --hard
```

`/skill` 用 UI notification 显示 active、inactive retained 和 hard cleared 状态；加载/卸载使用状态卡片。

## 配置

配置文件：`agent/configs/skill-context.jsonc`

```jsonc
{
	"$schema": "../schemas/skill-context.schema.json",
	"version": 1,
	"enabled": true,
	"max_active": 1,
	"on_load_conflict": "replace",
	"clear_mode": "lazy",
	"dedupe_read": true,
	"max_body_chars": 20000
}
```

字段：

- `enabled`: 启用 host-side skill context。
- `max_active`: 同时 active 的 skill 数。
- `on_load_conflict`: 超过 `max_active` 时 `replace` 停用旧 skill，`stack` 保留。
- `clear_mode`: `/skill clear` 默认 `lazy` 或 `hard`。
- `dedupe_read`: 阻止重复读取已加载 skill 的 `SKILL.md`。
- `max_body_chars`: 单个 skill body 字符上限。

## Prompt Cache

skill activation/deactivation 都写为 append-only custom entry。context hook 按这些 entry 在 branch 中的位置生成 synthetic message，不把 skill block 每轮移动到最新 user prompt 前。

如果连续 load/clear 之间没有真实会话消息，context hook 会只注入该段结束时的净效果。例如 load → clear → load 只产生最后一个 active `<skill>`；load → clear 不产生 skill block。

lazy clear 追加 inactive skill tag，旧 body 仍留在上下文前缀中；hard clear 只省略旧 body，不注入 inactive tag。
