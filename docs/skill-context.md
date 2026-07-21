# Skill Context

`skill-context` 提供静态 `skill` 工具、手动 `/skill:<name>` 加载和只读 `skill://` 资源定位。

## SKILL.md frontmatter

`SKILL.md` 使用 YAML frontmatter。当前允许的字段包括 Agent Skills 标准字段和 Pi 兼容字段；o-pi 不再新增权限字段：

| 字段 | 必填 | 类型与约束 | 当前行为 |
| --- | --- | --- | --- |
| `name` | 标准要求必填；o-pi 允许省略 | 1-64 个字符，只能包含小写字母、数字和单连字符；不能以连字符开头或结尾 | 省略时使用 `SKILL.md` 父目录名。为兼容其他客户端，应显式填写并与父目录名一致 |
| `description` | 是 | 非空字符串，最多 1024 个字符 | 用于 skill 索引和 `/skill` 命令说明，应同时描述功能和适用场景 |
| `license` | 否 | 简短的许可证名称，或指向 skill 内许可证文件的说明 | Agent Skills 标准字段；o-pi 接受但当前不消费，也不会随正文披露给模型 |
| `compatibility` | 否 | 非空字符串，标准上限为 500 个字符 | Agent Skills 标准字段，用于声明产品、系统依赖或网络要求；o-pi 当前不校验、不消费，也不会随正文披露给模型 |
| `metadata` | 否 | 字符串键到字符串值的映射 | Agent Skills 标准扩展容器；o-pi 当前不消费 |
| `allowed-tools` | 否 | 以空格分隔的工具声明字符串 | Agent Skills 实验字段；o-pi 当前忽略，不会授予工具权限或绕过审批 |
| `disable-model-invocation` | 否 | YAML 布尔值；Pi 默认 `false` | Pi 兼容字段；严格布尔值 `true` 时禁止模型发现和通过 `skill` 工具加载 |

完整示例：

```yaml
---
name: code-writing
description: 编写和修改代码；当任务需要实现、重构或修复代码时使用。
license: Apache-2.0
compatibility: Requires git and Node.js 22+
metadata:
  author: example-org
  version: "1.0"
allowed-tools: Read Bash(git:*)
disable-model-invocation: false
---
```

`disable-model-invocation` 完全采用 Pi 的解析结果，本仓库不再解释或覆盖该字段。Pi 只有在值为严格布尔值 `true` 时禁用模型调用；字段缺失、`false` 和非布尔值都不会禁用。为避免 YAML 类型歧义，需要禁用时应写成不带引号的 `true`。未列出的自定义信息应放入 `metadata`；顶层未知字段可能被 YAML 解析器接受，但不属于受支持接口，也不会产生运行时行为。

o-pi 加载时会移除整个 frontmatter，只向模型披露 Markdown 正文。因此，影响模型执行的环境要求和权限规则仍应写入正文；`compatibility`、`metadata` 和 `allowed-tools` 目前都不是运行时控制机制。

## 声明与索引

system prompt 只索引允许模型加载的 skill：

```text
<model_invocable_skills>
- code-writing: 编写和修改代码
</model_invocable_skills>
```

索引不包含正文、真实路径或资源列表。`skill` 工具使用固定 schema `skill({ name: string })`，skill 名称不会进入动态 enum。

索引直接使用 Pi 传入的 `BuildSystemPromptOptions.skills`，包括 Pi 已解析的名称、描述和 `disableModelInvocation`，不再读取或缓存 frontmatter。输出顺序仍与 Pi 的发现顺序一致。同名 skill 只保留一个；project skill 始终覆盖 user skill，其他同 scope 候选保留先发现者。

## 加载

模型只能通过 `skill` 工具加载 Pi 判定为可调用的 skill；`disable-model-invocation: true` 会禁止调用，缺失或 `false` 则允许。成功结果只包含逻辑根边界和去掉 frontmatter 的完整正文：

```text
<invoked_skill root="skill://code-writing"/>

SKILL.md body
```

用户执行 `/skill:<name>` 时可以加载任意已发现 skill。手动加载与工具加载复用同一执行器、校验、分支记录、去重和 UI 数据，但不会启动模型推理，也不会伪造 assistant tool call。

每次成功披露会写入 Host-only session custom entry，用于当前分支的资源权限和去重；该记录不复制正文、描述或调用策略。相同 content hash 不重复写入或披露正文；文件内容改变后允许追加新版本，后出现的版本生效。系统没有 unload、clear 或 active/inactive 状态。

`/skill` 只显示当前分支已披露的 skill。`/skill clear` 不再存在。

## 二级资源

已加载 skill 可让模型继续使用 `read` 读取相关资源：

```text
skill://code-writing/references/testing.md
skill://code-writing/assets/example.txt
```

`skill://` 只是 `read` 识别的只读逻辑定位符，不是操作系统路径。它不能传给 `write`、`edit` 或 shell。

资源解析遵守以下边界：

- 只允许当前 session branch 已加载的精确 skill 名称。
- 拒绝 `..`、`.`、空路径段、反斜杠、NUL、query、fragment 和百分号编码。
- 对 skill root 与目标执行 `realpath`，目标必须仍位于 root 内，符号链接不能逃逸。
- 模型输出和遥测中的读取路径保持逻辑 URI，不泄漏真实目录。
- 对已发现 skill root 的普通绝对路径读取会被拒绝，不能绕过 `skill://` 权限。
- skill 资源读取不运行 LSP 或 Repo Map 增强，也不会写入供 `edit` 使用的 read-version 缓存。

file-tools 扩展实例会复用 Pi 命令生成的 skill 候选和根目录索引。普通路径先执行无 I/O 的词法边界检查；只有检测外部符号链接时才按需解析并缓存 canonical roots。`skill://` 使用加载时已规范化的 root，只对目标执行 `realpath`。执行 `/reload` 后新扩展实例会重建这些缓存。

实现没有独立配置文件；`SKILL.md` 始终完整加载。
