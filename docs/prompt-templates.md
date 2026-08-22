# 提示词模板

提示词模板是可以通过斜杠命令展开的 Markdown 片段。文件名决定命令名。例如，`review.md` 注册为 `/review`。

Pi 负责解析模板、替换参数和处理同名冲突。本仓库的 `agent/extensions/agents-prompts.ts` 只通过 `resources_discover` 增加 `.agents/prompts` 中的模板文件。

## 加载位置

| 范围 | 路径 | 加载条件 |
| --- | --- | --- |
| 用户 | `~/.pi/agent/prompts/*.md` | 由 Pi 默认加载。 |
| 项目 | `<project>/.pi/prompts/*.md` | 项目受信任后由 Pi 加载。 |
| 用户 | `~/.agents/prompts/*.md` | 由本仓库扩展加载，不依赖项目信任状态。 |
| 项目 | `<project>/.agents/prompts/*.md` | 项目受信任后由本仓库扩展加载。 |

Pi 还支持从包中的 `prompts/` 目录、`package.json` 的 `pi.prompts`、设置中的 `prompts` 数组，以及重复使用的 `--prompt-template <path>` 参数加载模板。本仓库不改变这些来源的加载行为。

所有目录扫描均不递归。若需要加载子目录中的模板，应通过 Pi 设置、包清单或命令行参数明确添加对应路径。

## 模板格式

模板可以使用 Markdown 前置元数据：

```markdown
---
description: Review changes in the selected scope
argument-hint: "<scope> [focus]"
---
Review changes in $1.
Additional focus: ${@:2}
```

字段说明：

- `description`：可选。用于斜杠命令的展示说明。未设置时，Pi 使用模板正文的第一个非空行。该行超过 60 个字符时，Pi 保留前 60 个字符并追加 `...`。
- `argument-hint`：可选。在命令补全列表中显示参数提示。通常使用 `<name>` 表示必填参数，使用 `[name]` 表示可选参数。

前置元数据之外的正文是模板展开结果。文件名去除 `.md` 后成为命令名。

## 参数替换

模板支持以下占位符：

- `$1`、`$2`：按位置读取参数。缺少的参数替换为空字符串。
- `$@`、`$ARGUMENTS`：将全部参数用空格连接。
- `${N:-default}`：第 `N` 个参数缺失或为空时使用 `default`。
- `${@:-default}`、`${ARGUMENTS:-default}`：全部参数为空时使用 `default`。
- `${@:N}`：读取从第 `N` 个参数开始的全部参数。
- `${@:N:L}`：从第 `N` 个参数开始读取 `L` 个参数。

参数位置从 `1` 开始计数。调用模板时，单引号或双引号中的文本作为一个参数。例如：

```text
/review src "error handling"
```

参数值和默认值中的占位符不会再次展开。

## `.agents` 目录发现规则

`agent/extensions/agents-prompts.ts` 按以下规则发现模板：

- `~/.agents/prompts` 始终作为用户级资源扫描。
- 项目受信任后，从当前工作目录向上扫描每一级 `.agents/prompts`。
- 当前目录位于 Git 仓库中时，扫描包含 Git 根目录并在该处停止。当前目录不在 Git 仓库中时，扫描到文件系统根目录。
- 每个目录只返回直接包含的 `.md` 文件。
- 项目级符号链接只有在解析后的目标仍位于对应 `.agents/prompts` 目录内时才会加载。
- 不存在、无法读取或目标无效的目录与文件会被忽略。
- 同一路径只返回一次。

扩展只提供文件路径。模板解析、参数替换和命令注册仍由 Pi 完成。

## 同名模板

多个来源提供同名模板时，Pi 保留最先加载的模板，并记录名称冲突诊断。不同来源的加载顺序由 Pi 的资源加载器决定。模板不应依赖同名覆盖行为。
