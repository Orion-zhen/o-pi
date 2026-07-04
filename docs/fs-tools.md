# 文件工具设计

本项目只向 Pi agent 暴露五个文件工具：

* `ls`：发现某个目录下有什么。
* `find`：在目录下按 glob 递归查找文件。
* `grep`：在 UTF-8 workspace 文件中搜索文本。
* `read`：读取已知 UTF-8 文件内容和版本。
* `edit`：唯一写入口，通过 exact replacement 修改一个已有文件。

边界：

```text
使用 ls 浏览目录；
使用 find 按路径模式查找文件；
使用 grep 按内容定位匹配行；
使用 read 读取明确的文件；
使用 edit 修改文件；
不要使用 ls 读取文件；
不要使用 find 搜索文件内容；
不要使用 grep 查找文件路径或返回完整文件；
不要使用 read 列出目录；
如果目录结果过大，请列出更具体的子目录。
```

新增独立 `ls` / `find` / `grep` 是为了把目录浏览、路径模式查找、内容搜索和文件读取拆开，避免 `read` 自动降级成目录列表，也避免把文件发现或内容搜索混入 shell 行为。

扩展入口与实现分离：

* `agent/extensions/file-tools.ts`：注册 `ls` / `find` / `grep` / `read` / `edit`，定义工具 schema 和提示词元数据。
* `agent/extensions/block-builtin-tools.ts`：屏蔽 Pi 内置工具，保留扩展和 SDK 工具。
* `agent/configs/file-tools.jsonc`：文件工具配置。
* `agent/schemas/file-tools.schema.json`：配置 schema。
* `src/file-tools/`：实现路径解析、目录枚举、文本读取和 exact replacement 写入。
* `src/file-tools/ignore/`：实现统一 ignore engine、snapshot、explain 和 Git tracked set。

## ignore 与路径解析

ignore 和路径解析是两个独立维度：

```text
ignore：路径是否应从自动发现、遍历、搜索或索引中排除。
路径解析：把相对或绝对输入交给文件系统操作。
```

`.piignore` 和 `.gitignore` 不是访问控制机制。`ls` / `read` / `edit` 接受相对或绝对路径；只要 Pi 进程和操作系统允许访问，就可以执行。相对路径按当前 `cwd` 解析，绝对路径保持绝对。

状态行为：

* 普通路径：`ls` 返回，`read` 允许，`edit` 允许，未来搜索/索引包含。
* soft ignored：`ls` 返回并标记，显式 `read` 允许，`edit` 允许，`find` 默认跳过。
* cwd 外路径：允许访问；不套用当前 cwd 的 ignore 规则。
* blocked path：父目录 `ls` 隐藏，直接 `ls` / `read` / `edit` 拒绝。

## file-tools 配置

默认配置：

```jsonc
{
	"$schema": "../schemas/file-tools.schema.json",
	"version": 1,
	"blocked_path": [".git/"],
	"ignored_path": [],
	"limits": {
		"ls_entries": 200,
		"read_lines": 2000,
		"read_bytes": 51200,
		"find_output_token_budget": 800,
		"find_flat_result_limit": 5,
		"find_grouped_result_limit": 40,
		"find_max_matches_scanned": 100000,
		"find_max_exact_paths": 200,
		"grep_matching_lines": 40,
		"grep_max_matching_lines": 200,
		"grep_model_output_chars": 8000,
		"grep_snippet_chars": 240,
		"grep_context_lines": 3,
		"grep_max_file_bytes": 1048576,
		"grep_max_files_scanned": 100000
	},
	"ignore": {
		"piignore": true,
		"gitignore": true,
		"git_tracked_files_bypass": true,
		"builtin_profile": "minimal"
	}
}
```

字段：

* `blocked_path`：硬阻止路径。命中后不可列出、读取或写入；相对规则可匹配同名路径段，绝对规则按绝对路径匹配。目录规则以 `/` 结尾。
* `ignored_path`：软忽略路径。命中后 `ls` / `read` 返回 `ignored: true` 和 `ignore_source: "file-tools.jsonc"`，不阻止显式访问。
* `limits.ls_entries`：`ls` 单次最多返回条目数。
* `limits.read_lines`：`read` 单次最多返回行数。
* `limits.read_bytes`：`read` 单次最多返回 UTF-8 字节数。
* `limits.find_output_token_budget`：`find` 模型可见输出预算，使用字符数近似 token。
* `limits.find_flat_result_limit`：`find` 平铺输出的最大结果数；默认 5。
* `limits.find_grouped_result_limit`：`find` 按目录完整分组输出的最大结果数；默认 40，超过后进入折叠压缩。
* `limits.find_max_matches_scanned`：`find` 单次最多收集的匹配文件数，达到后标记 `truncated`。
* `limits.find_max_exact_paths`：`find` 最多展开的精确路径数，其余结果折叠为目录组。
* `limits.grep_matching_lines`：`grep` 默认返回的匹配行数。
* `limits.grep_max_matching_lines`：`grep limit` 可请求的最大匹配行数。
* `limits.grep_model_output_chars`：`grep` 模型可见文本硬上限。
* `limits.grep_snippet_chars`：`grep` 单行片段最大字符数，超长行围绕匹配内容裁剪。
* `limits.grep_context_lines`：`grep context` 最大对称上下文行数，默认 3。
* `limits.grep_max_file_bytes`：`grep` 单个候选文件最大读取字节数，超出则跳过或显式报错。
* `limits.grep_max_files_scanned`：`grep` 单次最多扫描候选文件数，达到后 `scan_complete: false`。
* `ignore.piignore`：是否读取 `.piignore`。
* `ignore.gitignore`：是否读取 `.gitignore`。
* `ignore.git_tracked_files_bypass`：Git tracked 文件是否绕过 `.gitignore`。
* `ignore.builtin_profile`：内置 soft ignore 规则，取值 `none`、`minimal` 或 `performance`。

配置损坏时工具返回 `CONFIG_ERROR`，不继续执行文件访问。

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

1. session override，当前为内部预留；
2. `.piignore`；
3. `.gitignore`；
4. `.git/info/exclude`，默认关闭；
5. Git global excludes，默认关闭；
6. builtin rules。

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

`ls` 只列出指定目录的直属成员。它无副作用、不递归、不读取文件内容、不搜索内容、不返回 size、mtime、权限、owner、inode 等 metadata。

参数：

```json
{
	"path": "src"
}
```

字段：

* `path`：目录路径。`.` 表示当前 `cwd`；相对路径按 `cwd` 解析；绝对路径保持绝对；空字符串非法。

模型可见成功结果使用紧凑 shell 风格文本，完整结构保留在 `details`：

```text
src 3
components/
index.ts
shared@ -> ../shared
```

entry：

* `name`：当前目录下的 basename。
* `path`：相对输入返回按 `cwd` 规范化后的相对路径；绝对输入返回绝对路径。
* `type`：`directory`、`file`、`symlink` 或 `other`。
* `link_target`：仅 symlink 可有，保留 `readlink` 返回的原始目标。
* `ignored`：命中 soft ignore 时为 `true`。
* `ignore_source`：可选简短来源，例如 `.piignore`、`.gitignore` 或 `builtin`。

紧凑文本规则：

* `name/`：目录。
* `name`：普通文件。
* `name@ -> target`：符号链接。
* `name?`：其他文件系统对象。
* ` !source`：soft ignored 标记。

dotfiles：

* `.gitignore`、`.github`、`.vscode`、`.env.example` 等普通 dotfile 会正常返回。
* dotfile 不等于 ignored。
* `.piignore` 和 `.gitignore` 自身正常出现在 `ls` 中。
* 默认 `blocked_path` 包含 `.git/`，因此 `.git` 隐藏且不能直接 `ls`、`read` 或 `edit`。

symlink：

* 父目录中的符号链接返回 `type: "symlink"`，不按目标类型改写。
* 直接 `ls` 一个符号链接路径时会先解析 realpath。
* 指向 cwd 外的 symlink 允许访问，最终由 Pi 进程和操作系统权限决定。
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

```text
vendor 200/8432 truncated
a/
[narrow path]
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
* `encoding`：当前固定为 `utf-8`。
* `newline`：`lf`、`crlf`、`mixed` 或 `none`。
* `bom`：是否带 UTF-8 BOM。
* `truncated` / `continuation`：输出被截断时告诉模型从哪一行继续读。
* `ignored` / `ignore_source`：显式读取 soft ignored 文件时返回；不阻止读取。

`read` 内部会在当前 session 记录基于原始字节计算的版本，用于后续 `edit` 自动校验；该版本不进入模型可见输出。

`read(directory)` 返回 `NOT_A_FILE`，不会自动列目录。

## find

`find` 只按路径 glob 查找普通文件，不读取内容、不返回目录、不修改文件。

参数：

```json
{
	"path": "src",
	"pattern": "**/*.{ts,tsx}"
}
```

字段：

* `path`：workspace-relative 搜索根目录，默认 `.`；不能是绝对路径或越过 workspace。
* `pattern`：相对于 `path` 的 glob；`**` 表示递归；空字符串非法。

成功结果是紧凑文本：

```text
3 files
src/a.ts
src/components/button.tsx
src/index.ts
```

大量结果按公共目录前缀压缩：

```text
90 files; 9 exact, 81 summarized

a/
  file-00.ts
  file-01.ts
  file-02.ts

a/** (27)
b/** (27)
c/** (27)
```

行为：

* 结果路径始终相对 workspace root，统一使用 `/`。
* 只返回普通文件；文件 symlink 不返回，目录 symlink 不进入。
* 目录遍历使用 ignore `traverse` intent；文件匹配使用 `search` intent。
* `blocked_path` 命中时拒绝或跳过；`.git/` 默认不可查。
* 输出预算、最大扫描数和精确路径数由 `agent/configs/file-tools.jsonc` 的 `limits` 控制，不暴露为工具参数。

## grep

`grep` 只在 workspace 内的 UTF-8 普通文本文件中搜索内容，不查找路径、不返回完整文件、不修改文件。

参数：

```json
{
	"path": "src",
	"query": "createSnapshot(",
	"mode": "content",
	"regex": false,
	"glob": "**/*.ts",
	"ignore_case": false,
	"context": 0,
	"limit": 40
}
```

字段：

* `path`：workspace 内的目录或普通文件；目录递归搜索，文件只搜索该文件。
* `query`：搜索文本。默认按字面量匹配，只有 `regex: true` 时才按正则解释。
* `mode`：`content` 返回匹配行；`files` 只返回匹配文件和计数；`count` 只返回总计数。默认 `content`。
* `glob`：相对 `path` 的 glob，只进一步缩小候选文件范围；ignore、symlink 和 workspace 边界仍由工具统一处理。
* `ignore_case`：默认大小写敏感。
* `context`：对称上下文行数，范围 0-3，默认 0；重叠或相邻上下文区间会合并。
* `limit`：`content` 模式最多返回的匹配行数，范围 1-200，默认 40。

`content` 输出按文件聚合，文件路径只出现一次，同一行多个 occurrence 用 `×N` 标记：

```text
23 lines / 31 occurrences in 6 files; showing 12 lines

src/a.ts [8 lines, 10 occurrences]
12: export function createSnapshot(root: string) {
19×2: return createSnapshot(createSnapshot(root))
... 6 matching lines omitted
```

`files` 输出只展示分布：

```text
31 occurrences / 23 lines / 6 files
src/a.ts  8 lines / 10 occurrences
src/b.ts  3 lines / 3 occurrences
```

`count` 输出不包含路径和源码：

```text
31 occurrences / 23 lines / 6 files
```

行为：

* 普通 dotfile 可搜索；`.git/` 等 `blocked_path` 不可搜索。
* 目录遍历使用 ignore `traverse` intent；文件搜索使用 `search` intent。
* ignored 文件不搜索；可 prune 的 ignored 目录不进入；存在反向 include 可能性的目录按 ignore engine 语义继续遍历。
* 递归时不跟随文件或目录 symlink；显式 `path` 解析到 workspace 外时拒绝。
* 二进制、非法 UTF-8、超大文件和局部权限失败在递归搜索中计入 `skipped_files`；显式搜索单个文件时返回对应错误。
* 采样按文件轮转分配：每个匹配文件先返回一条，再返回第二条，避免高频文件占满输出。
* 超长行围绕首个匹配位置裁剪，保证片段包含匹配内容。

完整性：

* `scan_complete: true` 且 `output_truncated: false`：扫描和输出都完整。
* `scan_complete: true` 且 `output_truncated: true`：扫描完成，总计数精确，但模型可见输出被压缩。
* `scan_complete: false`：扫描未完成，总计数是下界；模型可见输出使用 `>=`。

无效正则、路径错误、权限错误、取消和搜索后端错误不会伪装成零匹配。

## edit

`edit` 只修改一个已存在的 UTF-8 文件，不创建、删除、移动或完整替换文件，不接受 patch/diff DSL。

参数：

```json
{
	"path": "src/main.ts",
	"edits": [
		{ "old": "runOld();", "new": "runNew();" }
	]
}
```

规则：

* 文件必须存在且必须先显式 `read`。
* `edits` 非空；每个 `old` 必须非空、在原文件中唯一。
* 所有替换都针对调用开始时的原始文件匹配，不按前一个替换后的内容继续匹配。
* 同一次调用的替换范围不得重叠；相邻或重叠修改应合并成一个 `old/new`。
* 一次调用只编辑 `path` 指向的一个文件，但可修改该文件多个位置。

`read` 会在当前 session 记录文件版本；`edit` 自动使用该版本校验写入前内容。如果文件未读过，`edit` 返回 `READ_REQUIRED`。如果磁盘内容已变化，`edit` 返回 `STALE_READ`，不会自动合并或覆盖外部修改。

soft ignore 不阻止 `edit`。`edit` 只依据文件系统访问结果、文件类型、上次读取版本和 operation 合法性决定是否修改。

TUI 会在参数完整后执行只读预览并在 call 区显示 diff；真正执行仍必须通过 read-before-edit 和版本校验。成功后如果结果 diff 与预览一致，结果区不重复展示 diff。

成功结果的 `diff` 是 Pi TUI 展示用的精简行号 diff，`firstChangedLine` 保存首个变更行号；模型可见正文不包含版本字段。

## 路径解析

`ls`、`read`、`edit` 共享 `src/file-tools/path-resolver.ts`。

路径先按当前 `cwd` 解析。工具只主动拒绝：

* 空路径；
* 空字节；
* 命中 `blocked_path`。

路径可以是相对路径、`..` 路径、绝对路径、包含 glob 字符的普通文件名，或指向 cwd 外的符号链接。工具不会展开 glob。

常见错误：

* `PATH_NOT_FOUND`：`ls` 目标目录不存在。
* `FILE_NOT_FOUND`：`read` 目标文件不存在。
* `NOT_A_DIRECTORY`：`ls` 目标存在但不是目录。
* `NOT_A_FILE`：`read` 目标存在但不是普通文件。
* `PROTECTED_PATH`：目标命中 `blocked_path`。
* `CONFIG_ERROR`：`agent/configs/file-tools.jsonc` 缺失 schema、JSONC 语法错误或不符合 schema。
* `ACCESS_DENIED`：运行时无权访问目标。

恢复方式：

* `NOT_A_DIRECTORY`：改用 `read` 读取明确文件，或 `ls` 其父目录。
* `NOT_A_FILE`：改用 `ls` 浏览目录。
* `truncated: true`：继续 `ls` 更具体的子目录。
* `READ_REQUIRED`、`STALE_READ` 或 `OLD_TEXT_*`：重新 `read`，基于最新内容生成新的 `edit` replacement。
* 文件未出现在未来搜索/索引中：用 ignore snapshot 的 `explain` 查看 `winner.sourcePath` 和 `winner.line`。

## 提示词设计

工具提示词遵循最小 token 原则：协议约束尽量放进 schema 字段描述，系统提示词只保留关键决策规则。

当前文件类 agent tools 最终为：

```text
ls
find
grep
read
edit
```
