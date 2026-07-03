# 文件工具设计

本项目只向 Pi agent 暴露三个文件工具：

* `ls`：发现某个目录下有什么。
* `read`：读取已知 UTF-8 文件内容和版本。
* `edit`：唯一写入口，通过结构化 `operations` 修改文件系统状态。

边界：

```text
使用 ls 浏览目录；
使用 read 读取明确的文件；
使用 edit 修改文件；
不要使用 ls 读取文件；
不要使用 read 列出目录；
如果目录结果过大，请列出更具体的子目录。
```

新增独立 `ls` 是为了把目录发现从文件读取中拆出，避免 `read` 自动降级成目录列表，也避免把目录浏览混入 shell、glob、grep 或 tree 行为。

扩展入口与实现分离：

* `agent/extensions/file-tools.ts`：注册 `ls` / `read` / `edit`，定义工具 schema 和提示词元数据。
* `agent/extensions/block-builtin-tools.ts`：屏蔽 Pi 内置工具，保留扩展和 SDK 工具。
* `agent/extensions/permissions.ts`：注册 `/permissions` 命令并管理权限会话状态。
* `src/file-tools/`：实现路径安全、目录枚举、文本读取、diff 匹配、事务提交和回滚。
* `src/file-tools/ignore/`：实现统一 ignore engine、snapshot、explain 和 Git tracked set。

## ignore 与 permission

ignore 和权限系统是两个独立维度：

```text
ignore：路径是否应从自动发现、遍历、搜索或索引中排除。
permission：agent 是否有权访问或修改路径。
```

`.piignore` 和 `.gitignore` 不是安全机制。敏感路径、workspace/external/system/sensitive 边界、符号链接 canonical target 和权限策略由 `src/permissions/` 处理；ignore 规则不能覆盖 permission，`!pattern` 也不能解除安全限制。

状态行为：

* 普通路径：`ls` 返回，`read` 允许，`edit` 允许，未来搜索/索引包含。
* soft ignored：`ls` 返回并标记，显式 `read` 允许，`edit` 允许，未来搜索/索引默认跳过。
* permission denied：按权限系统隐藏或拒绝，不标记为 ignored。

默认配置：

```ts
{
	piignore: { enabled: true, filename: ".piignore", nested: true },
	gitignore: { enabled: true, nested: true, trackedFilesBypass: true },
	gitInfoExclude: false,
	globalGitignore: false,
	builtinProfile: "minimal",
	caseSensitivity: "auto",
	diagnostics: "warn"
}
```

规则来源优先级从高到低：

1. permission，独立且不可覆盖；
2. session override，当前为内部预留；
3. `.piignore`；
4. `.gitignore`；
5. `.git/info/exclude`，默认关闭；
6. Git global excludes，默认关闭；
7. builtin rules。

同一来源中，子目录规则优先于父目录规则；同一文件中，后面的匹配规则覆盖前面的规则。

## ignore engine

`.piignore` 使用 Gitignore pattern grammar，支持根目录和嵌套文件。`.gitignore` 同样支持嵌套。规则使用 workspace-relative lexical path 匹配，内部统一 `/` 分隔，不使用 symlink realpath 改写逻辑路径。

匹配结果不是 boolean：

```ts
type IgnoreDecision = {
	state: "none" | "ignore" | "include";
	ignored: boolean;
	prune: boolean;
	matchedRule?: {
		sourceType: "builtin" | "gitignore" | "piignore" | "git-info-exclude" | "global" | "session";
		sourcePath?: string;
		line?: number;
		pattern: string;
		negated: boolean;
		baseDirectory: string;
	};
	diagnostics?: IgnoreDiagnostic[];
};
```

`ignored` 和 `prune` 分开：路径可以被忽略，但如果存在可能重新包含后代的 `!pattern`，遍历器不能安全剪枝。`prune` 只用于未来遍历、搜索和索引；`ls` 仍只列直属成员。

snapshot：

* 每次工具调用创建一个不可变 ignore snapshot。
* snapshot 绑定配置、规则文件版本、Git tracked set、内置规则和 session override。
* `evaluate` / `explain` 不读取磁盘。
* 引擎按 workspace 缓存 snapshot；规则文件 path + size + mtime、tracked set 或配置变化会创建新 snapshot。
* `edit` 修改 `.piignore` / `.gitignore` 后，后续工具调用会通过新 snapshot 看到新规则。

explain 能定位最终规则来源：

```ts
{
	path: "dist/schema.json",
	ignored: true,
	prune: false,
	trace: [{ sourceType: "piignore", sourcePath: ".piignore", line: 3, pattern: "dist/" }],
	winner: { sourceType: "piignore", sourcePath: ".piignore", line: 3, pattern: "dist/" }
}
```

Git tracked files：

* 默认批量读取 `git ls-files -z`。
* 已 tracked 的路径不会被 `.gitignore` soft ignore。
* `.piignore` 仍可忽略 tracked 文件。
* 非 Git 仓库安全退化为空 tracked set。

诊断：

* ignore 文件默认只支持 UTF-8，BOM 会被剥离。
* ignore 文件读取或编码错误会产生结构化 diagnostics，并 fail-open 继续应用其他有效规则。
* diagnostics 不直接塞进 `ls` entry，避免工具输出膨胀；开发者可用 snapshot `explain` 调试。

## ls

`ls` 只列出指定目录的直属成员。它无副作用、不递归、不读取文件内容、不搜索内容、不支持 glob、不返回 size、mtime、权限、owner、inode 等 metadata。

参数：

```json
{
	"path": "src"
}
```

字段：

* `path`：目录路径。`.` 表示 workspace root；外部绝对路径按权限策略处理；空字符串非法。

成功结果：

```json
{
	"path": "src",
	"entries": [
		{ "name": "components", "path": "src/components", "type": "directory" },
		{ "name": "index.ts", "path": "src/index.ts", "type": "file" },
		{ "name": "shared", "path": "src/shared", "type": "symlink" }
	],
	"truncated": false
}
```

entry：

* `name`：当前目录下的 basename。
* `path`：workspace 内返回相对规范化路径；外部目录返回绝对路径。
* `type`：`directory`、`file`、`symlink` 或 `other`。
* `ignored`：命中 soft ignore 时为 `true`。
* `ignore_source`：可选简短来源，例如 `.piignore`、`.gitignore` 或 `builtin`。

dotfiles：

* `.gitignore`、`.github`、`.vscode`、`.env.example` 等普通 dotfile 会正常返回。
* dotfile 不等于 ignored，也不等于 blocked。
* `.piignore` 和 `.gitignore` 自身正常出现在 `ls` 中，除非被 permission 禁止。

blocked：

* `.git` 等受保护路径不能直接 `ls`。
* 父目录列表中受保护直属成员会隐藏，并通过 `blocked_entries` 计数。
* blocked 不是 ignored，不能用 `ignored: true` 表示。

symlink：

* 父目录中的符号链接返回 `type: "symlink"`，不按目标类型改写。
* 直接 `ls` 一个符号链接路径时会先解析 realpath。
* canonical target 决定权限边界；workspace 内 symlink 指向 external 时进入 ask/deny 流程。
* `ls` 不递归，因此不会遍历 symlink cycle。
* symlink entry 按其逻辑名称参与 ignore 匹配。

排序：

1. `directory`
2. `file`
3. `symlink`
4. `other`
5. 同类型内按 `name.toLowerCase()` 排序。
6. 大小写折叠相同时按原始 `name` 排序。

排序不依赖文件系统返回顺序、mtime、size 或当前 locale。

截断：

* `ls` 最多返回 200 个可见直属成员。
* 超出时返回前 200 个稳定排序条目，并设置 `truncated: true`。
* 同时返回 `returned_entries`、`total_entries` 和 `continuation_hint`。
* 不做自动递归、自动过滤或 cursor 分页。

截断示例：

```json
{
	"path": "vendor",
	"entries": [
		{ "name": "a", "path": "vendor/a", "type": "directory" }
	],
	"truncated": true,
	"returned_entries": 200,
	"total_entries": 8432,
	"continuation_hint": "List a more specific subdirectory."
}
```

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

返回内容包括：

* `content`：原始文本片段，不带行号。
* `start_line` / `end_line` / `total_lines`：范围元数据。
* `size_bytes`：原始文件字节数。
* `version`：`sha256:<hash>`，基于文件原始字节。
* `encoding`：当前固定为 `utf-8`。
* `newline`：`lf`、`crlf`、`mixed` 或 `none`。
* `bom`：是否带 UTF-8 BOM。
* `truncated` / `continuation`：输出被截断时告诉模型从哪一行继续读。
* `ignored` / `ignore_source`：显式读取 soft ignored 文件时返回；不阻止读取。

`read(directory)` 返回 `NOT_A_FILE`，不会自动列目录。

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

任何作用于已有文件的 operation 都必须使用 `read` 返回的 `version` 作为 `base_version`。如果磁盘内容已变化，`edit` 返回 `STALE_BASE_VERSION`，不会自动合并或覆盖外部修改。

soft ignore 不阻止 `edit`。`edit` 仍只依据权限系统、文件类型、base version 和 operation 合法性决定是否修改。

## 路径安全

`ls`、`read`、`edit` 共享 `src/file-tools/path-security.ts`。

路径先做格式校验和 canonicalization，再交给权限系统。工具拒绝：

* 空路径；
* Windows drive-relative 路径；
* 空字节；
* glob 特殊字符；
* 权限系统判定 deny 的路径；
* 无 UI 时需要 ask 的路径。

常见错误：

* `PATH_NOT_FOUND`：`ls` 目标目录不存在。
* `FILE_NOT_FOUND`：`read` 目标文件不存在。
* `NOT_A_DIRECTORY`：`ls` 目标存在但不是目录。
* `NOT_A_FILE`：`read` 目标存在但不是普通文件。
* `PERMISSION_PROMPT_UNAVAILABLE`：策略需要询问，但当前无 UI。
* `PERMISSION_DENIED`：权限策略拒绝，或运行时无权访问目标。
* `PERMISSION_PROTECTED_RESOURCE`：普通 `edit` 尝试修改权限/Pi 受保护资源。
* `PERMISSION_CONTEXT_CHANGED`：授权后、I/O 前路径 identity 或 canonical target 变化。

恢复方式：

* `NOT_A_DIRECTORY`：改用 `read` 读取明确文件，或 `ls` 其父目录。
* `NOT_A_FILE`：改用 `ls` 浏览目录。
* `truncated: true`：继续 `ls` 更具体的子目录。
* `STALE_BASE_VERSION` 或 `DIFF_CONTEXT_*`：重新 `read`，基于最新内容生成新的 `edit` operation。
* 文件未出现在未来搜索/索引中：用 ignore snapshot 的 `explain` 查看 `winner.sourcePath` 和 `winner.line`。

## 提示词设计

工具提示词遵循最小 token 原则：协议约束尽量放进 schema 字段描述，系统提示词只保留关键决策规则。

当前文件类 agent tools 最终为：

```text
ls
read
edit
```
