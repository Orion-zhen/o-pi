# 文件工具设计

本项目只向 Pi agent 暴露两个文件工具：

* `read`：观察 workspace 文件状态，无副作用。
* `edit`：唯一写入口，通过结构化 `operations` 修改文件。

扩展入口与实现分离：

* `agent/extensions/file-tools.ts`：注册 `read` / `edit`，定义工具 schema 和提示词元数据。
* `agent/extensions/active-tools.ts`：屏蔽不需要的 Pi 内置工具，保持自定义 `read` / `edit` 启用。
* `src/file-tools/`：实现路径安全、文本读取、diff 匹配、事务提交和回滚。

## read

`read` 只读取 UTF-8 文本文件，不修改文件、不格式化、不改变换行符，也不写入工作区状态。

参数：

```json
{
	"path": "src/main.ts",
	"start_line": 1,
	"end_line": 80
}
```

字段：

* `path`：workspace 相对路径。
* `start_line`：可选，1-based，包含该行。
* `end_line`：可选，1-based，包含该行。

返回内容包括：

* `content`：原始文本片段，不带行号。
* `start_line` / `end_line` / `total_lines`：范围元数据。
* `size_bytes`：原始文件字节数。
* `version`：`sha256:<hash>`，基于文件原始字节。
* `encoding`：当前固定为 `utf-8`。
* `newline`：`lf`、`crlf`、`mixed` 或 `none`。
* `bom`：是否带 UTF-8 BOM。
* `truncated` / `continuation`：输出被截断时告诉模型从哪一行继续读。

机制：

1. 路径先按 workspace 相对路径解析。
2. 对真实路径执行 workspace 内校验，拒绝绝对路径、`..`、逃逸符号链接和 `.git` 等受保护目录。
3. 读取原始字节，计算 SHA-256 版本。
4. 严格 UTF-8 解码；二进制或非法 UTF-8 返回结构化错误。
5. 按行范围和输出限制返回内容；截断必须显式返回 `continuation.start_line`。

## edit

`edit` 只接受结构化 `operations`，不接受字符串 patch DSL，不提供独立的写入、替换、删除、移动工具。

参数：

```json
{
	"operations": [
		{
			"type": "update_file",
			"path": "src/main.ts",
			"base_version": "sha256:...",
			"diff": "@@\n export function main() {\n-  runOld();\n+  runNew();\n }"
		}
	]
}
```

支持的 operation：

* `create_file`：`path`、`content`。只创建新文件，目标存在返回 `FILE_ALREADY_EXISTS`。
* `update_file`：`path`、`base_version`、`diff`。局部修改已有文件。
* `replace_file`：`path`、`base_version`、`content`。完整替换已有文件，不创建新文件。
* `delete_file`：`path`、`base_version`。删除已有普通文件。
* `move_file`：`from`、`to`、`base_version`。移动已有普通文件，目标必须不存在。

`update_file.diff` 是单文件 context diff：

```text
@@
 context
-old
+new
```

规则：

* `@@` 分隔 hunk。
* 空格开头是上下文行。
* `-` 开头是删除行。
* `+` 开头是新增行。
* 不包含文件路径、文件头或完整 Git patch 元数据。
* 严格逐行匹配，要求上下文唯一。
* 不做模糊匹配、空白忽略、缩进忽略或相似度匹配。

机制：

1. 校验 `operations` 是非空数组。
2. 按 `type` 校验每个 operation 的字段，拒绝多余字段。
3. 规范化并验证所有路径。
4. 检测同一路径、大小写等价路径、move 源/目标等 operation 冲突。
5. 对已有文件校验 operation 内的 `base_version`。
6. 在内存中计算全部最终内容。
7. 全部验证成功后提交文件。
8. 提交失败时按原始状态回滚。

成功结果按输入 operation 顺序返回：

```json
{
	"status": "applied",
	"transaction_id": "txn_...",
	"results": [
		{
			"index": 0,
			"type": "update_file",
			"path": "src/main.ts",
			"old_version": "sha256:...",
			"new_version": "sha256:..."
		}
	],
	"diff": "..."
}
```

`diff` 是最终实际变更的 unified diff，只用于审计和展示，不是输入协议。

## 版本与并发控制

`read` 返回的 `version` 是文件原始字节的 SHA-256。任何作用于已有文件的 operation 都必须带 `base_version`：

```json
{
	"type": "replace_file",
	"path": "config.json",
	"base_version": "sha256:...",
	"content": "{}\n"
}
```

如果磁盘内容已变化，`edit` 返回 `STALE_BASE_VERSION`，不会自动合并、重新解释旧 diff 或覆盖外部修改。

标准恢复流程：

1. 调用 `read` 获取目标文件内容和 version。
2. 基于读取内容生成 operation。
3. 调用 `edit({ "operations": [...] })`。
4. 如果返回 `STALE_BASE_VERSION` 或 `DIFF_CONTEXT_*`，重新 `read`，基于最新内容生成新 operation。

## 路径安全

所有路径都按 workspace 相对路径处理。工具拒绝：

* 绝对路径；
* `..` 逃逸；
* 解析后位于 workspace 外的符号链接；
* 指向 workspace 外的 move 目标；
* `.git` 等受保护路径。

路径校验集中在 `src/file-tools/path-security.ts`，避免 `read` 和 `edit` 各自实现不同规则。

## 编码与换行

当前只支持 UTF-8 文本文件。

* UTF-8 BOM 会被识别，并在编辑已有文件时保留。
* `read` 区分 `lf`、`crlf`、`mixed`、`none`。
* `update_file` 保留原文件主要换行风格。
* `replace_file` 使用 operation 的 `content` 作为完整结果，并保留原文件 BOM。
* 二进制文件返回 `BINARY_FILE_UNSUPPORTED`。
* 非法 UTF-8 返回 `ENCODING_UNSUPPORTED`。

## 提示词设计

工具提示词遵循最小 token 原则：把协议约束尽量放进 schema 字段描述，而不是塞进系统提示词长段落。

`read` 的提示词元数据：

* `description`：说明它是无副作用 UTF-8 读取工具，并返回内容、版本、编码、换行和截断信息。
* `promptSnippet`：一行进入 Pi 默认 `Available tools` 区域。
* `promptGuidelines`：只保留两个会影响行为的规则：
  * 修改已有文件前先 `read`，把返回的 version 放进 operation 的 `base_version`。
  * 遇到版本冲突或 diff 上下文错误时重新 `read`，不要重复提交旧 operation。

`edit` 的提示词元数据：

* `description`：说明它原子应用结构化 operations，已有文件必须使用 `read` 返回的版本。
* `promptSnippet`：一行概括 all-or-nothing 事务。
* `promptGuidelines`：强调 `edit` 是唯一写入口，`create_file` 和 `replace_file` 语义分离。

`edit` 的主要协议教学放在 JSON Schema：

* `operations` 使用 `type` 区分 operation。
* 每种 operation 声明不同必填字段。
* `additionalProperties: false` 拒绝不适用字段。
* `diff` 字段说明单文件 context diff 的 hunk、上下文、删除和新增行语法。

这样模型能从 tool schema 获得调用格式，同时系统提示词只保留关键决策规则。
