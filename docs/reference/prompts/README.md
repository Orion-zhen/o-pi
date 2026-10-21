# 提示词

系统提示词表达角色、运行环境和长期工具规则。参数约束交给 schema，当次恢复步骤放在工具结果中。

## 系统提示词组成

```text
custom_prompt 或 role
cwd
工具策略 tool_policy
技能策略 skill_policy
可调用技能 skills
append_system_prompt
项目规则 project_context
子代理索引 subagents
```

空段落省略。`SYSTEM.md` 替换默认角色，`APPEND_SYSTEM.md` 追加指令，项目 `AGENTS.md` 进入项目规则。

Pi 将命名段落和工具声明写入会话，后续追加变更。支持中途系统消息的模型保留这些段落，其他模型由 SDK 合并。

`/system` 在运行中读取实际请求投影，空闲时读取分支中已持久化的指令，首次输入前预览合成结果。fork 子代理使用父请求保存的完整提示词。

## 工具字段

| 字段 | 用途 |
| --- | --- |
| `name` | 工具调用名 |
| `label` | 界面短标签 |
| `description` | 模型可见能力说明 |
| `parameters` | 参数 schema |
| `promptSnippet` | Pi 默认提示词和 Codemode 目录使用的摘要 |
| `promptGuidelines` | 工具贡献的长期使用规则 |
| `execute` | 执行逻辑，返回模型内容与宿主数据 |

opi 的系统提示词收集已选工具的 `promptGuidelines` 到 `tool_policy`，工具能力和参数由原生声明提供。Codemode 的目录由 SDK 生成，见 [Codemode](../codemode/README.md)。

## 写法

- 一句话表达一个动作或条件。
- 名称、能力和参数各写在对应字段。
- 共享规则只保留一处。
- 长期规则写工具选择与执行边界。
- 分页、截断和失败恢复写在对应工具结果中。
- 使用类型、枚举、范围和互斥结构表达可校验约束。
- 模型可见的自生成标签使用紧凑 ASCII，原始内容保留 Unicode。

技能索引只包含名称和描述，正文按需加载。子代理索引同样只展示名称和描述。

## 来源

系统提示词合成位于 `src/harness/system-prompt/service.ts`，当前提示词读取位于 `current.ts`。命令模板见[提示词模板](templates.md)。
