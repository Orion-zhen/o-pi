# 提示词设计哲学

本仓库的提示词目标是：用最少长期上下文表达稳定、正交、可执行的行为边界。提示词只解决模型决策问题；能由 schema、运行时、工具结果或代码结构表达的内容，不写进长期提示词。

## 核心原则

* 最小上下文：只保留会持续影响模型选择的文字。
* 分层清晰：每条信息只属于一个最合适的位置。
* 工具自治：工具通过 provider-native definition 维护能力说明，通过 `promptGuidelines` 维护长期边界。
* 语义正交：工具之间按任务意图拆分，避免多个工具描述同一职责。
* 专用优先：多个 active tools 都能完成任务时，选择语义最精准的工具。
* 结果驱动恢复：低频恢复步骤放进当次 tool result，不常驻 system prompt。
* 结构优先：先用类型、schema、运行时约束和返回结构解决问题，再考虑提示词。

## 分层职责

### system prompt

只放跨工具、长期有效、无法下沉到单个工具的 harness 不变量。

当前结构：

```text
custom_prompt 或 role
tool_policy
skill_policy（仅扫描到 skill 时）
append_system_prompt
project_context
subagents
context
```

`custom_prompt` 可以替换角色、风格和通用行为，但不能移除共享工具策略。`system-prompt.ts` 只合成 active tools 的长期规则和最小 skill 策略，不维护具体工具或 skill 能力表。工具名、能力和参数由 provider-native tool definition 提供。

### `<tool_policy>`

放全局路由规则和 active tools 贡献的长期规则。

来源：

* 固定全局规则：例如选择最窄 active tool。
* active tools 的 `promptGuidelines`：工具边界中确实需要长期驻留的短规则。

禁止放入：

* 参数格式；
* 默认值；
* 分页、截断、重试和错误恢复流程；
* 某个工具的完整使用手册；
* 与 schema、description 或 tool result 重复的信息。

### tool `description`

进入 provider-native tool definition，用于帮助模型判断工具能力。写法是“动作 + 对象 + 核心边界”。

示例：

```text
Search literal text or regex in workspace files; return matching lines, paths, or counts.
```

不要写：

* 参数协议；
* 错误恢复；
* 配置来源；
* renderer 行为；
* 与 parameter schema 或 system policy 重复的长说明。

### parameter schema

描述字段含义、默认值、约束和调用模式。

优先使用：

* `Type.Integer` 表达整数；
* `additionalProperties: false` 拒绝未知字段；
* `minItems` 表达非空数组；
* 判别联合表达互斥模式；
* 字段 description 表达局部含义。

调用协议能进 schema 时，不写进长期提示词。

### tool result

描述当次调用的事实、失败原因和下一步。

适合放：

* `READ_REQUIRED` / `STALE_READ` 的 `next`；
* `next_offset`、`has_more` 和继续读取方式；
* 只有真正截断时才提示完整日志路径；
* 当次错误的精确恢复建议。

工具结果应尽量机器可读，模型可见文本保持短而明确。

### runtime

强制执行安全、权限、路径、网络、并发、取消和参数限制。不能依赖提示词保证安全边界。

如果运行时已经强制执行，不在提示词中重复威慑式说明；只在该信息影响模型正确选择时保留简短边界。

## 工具提示词字段语义

本项目只把 `promptGuidelines` 合成到 `<tool_policy>`。`promptSnippet` 仅供未启用本扩展时的 Pi 默认 prompt 使用，不进入本项目合成的 system prompt。

示例：

```ts
promptGuidelines: [
  "Use bash for tests, builds, formatters, compilers, generators, git, and other external programs; files changed by those programs remain bash output."
]
```

`system-prompt.ts` 只负责合成和去重 Pi 提供的 active tool guidelines，不根据具体工具名追加规则。

## 判断一条提示词应放哪里

按顺序判断：

1. 能由运行时强制吗？放 runtime。
2. 能由 schema 表达吗？放 parameter schema。
3. 只在失败、分页或截断后需要吗？放 tool result。
4. 是某个工具的能力或长期路由边界吗？放 description 或 promptGuidelines。
5. 是跨工具长期不变量吗？放 `<tool_policy>`。
6. 只是项目开发规范吗？放 `AGENTS.md`。

如果一条信息可以放在多个层，选择离事实来源最近、token 成本最低的一层。

## 压缩规则

* 删除寒暄、身份重复和解释性铺垫。
* 用肯定式短句替代冗长禁止清单。
* 不枚举 schema 已经约束的字段。
* 不把低频错误流程常驻。
* 不通过新增提示词修补代码、schema 或架构问题。
* 修改提示词后检查重复、冲突和可合并项。

## 反模式

* 在 `system-prompt.ts` 按工具名硬编码路由规则。
* 在多个工具 description 中重复同一边界。
* 在 `promptGuidelines` 中写分页、截断、重试、错误恢复细节。
* 用提示词声明安全限制，但运行时不强制。
* 用长示例代替 schema。
* 为兼容旧工具协议保留提示词适配层。

## 提交前检查

* 新增文本是否确实影响模型决策？
* 是否已经由 schema、runtime 或 tool result 表达？
* 是否只在相关工具 active 时出现？
* 是否引用了未启用工具？
* 是否与 tool definition 或 AGENTS.md 重复？
* 是否可以用更短、更直接的句子表达？
* system prompt 快照和相关 schema/tool result 测试是否覆盖变更？
