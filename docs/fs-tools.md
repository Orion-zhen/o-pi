# 文件工具设计

本项目只向 Pi agent 暴露六个文件工具：

* `ls`：发现某个目录下有什么。
* `find`：按名称、路径片段或 glob 定位文件和目录。
* `grep`：按内容、symbol、正则或代码意图检索代码区域。
* `read`：读取已知 UTF-8 文件内容和版本。
* `write`：创建或完整覆盖一个 UTF-8 文件。
* `edit`：通过 exact replacement 修改一个已有文件。

LSP 是这些工具的内部增强，不是模型可见工具。仓库不注册 `lsp` tool，只提供用户调试命令 `/lsp`。

边界：

```text
ls    浏览已知目录
find  按路径定位文件或目录
grep  按内容、symbol 或代码意图定位代码
使用 read 读取明确的文件；
使用 write 创建或完整覆盖文件；
使用 edit 修改已有文件局部内容；
不要使用 ls 读取文件；
不要使用 find 搜索文件内容；
不要使用 grep 查找文件路径或读取整文件；
不要使用 read 列出目录；
如果目录结果过大，请列出更具体的子目录。
```

新增独立 `ls` / `find` / `grep` 是为了把目录浏览、路径模式查找、内容搜索和文件读取拆开，避免 `read` 自动降级成目录列表，也避免把文件发现或内容搜索混入 shell 行为。

扩展入口与实现分离：

* `agent/extensions/file-tools.ts`：注册 `ls` / `find` / `grep` / `read` / `write` / `edit`，定义工具 schema 和提示词元数据。
* `agent/extensions/block-builtin-tools.ts`：屏蔽 Pi 内置工具，保留扩展和 SDK 工具。
* `agent/configs/file-tools.jsonc`：用户级文件工具配置。
* `agent/schemas/file-tools.schema.json`：配置 schema。
* `src/file-tools/`：实现路径解析、目录枚举、文本读取、文件写入和 exact replacement。
* `src/file-tools/ignore/`：实现统一 ignore engine、snapshot、explain 和 Git tracked set。
* `src/safety/path-guard.ts`：实现多个文件工具共享的 `blocked_path` lexical / realpath 检查。
* `src/lsp/`：可选 LSP 后端，为 `grep` / `read` / `write` / `edit` 附加 symbol、outline 和 diagnostics。

LSP 失败、超时、未配置或 language server binary 不存在时，文件工具静默退化为原行为。`ls` 和 `find` 不接入 LSP。

## ignore 与路径解析

ignore 和路径解析是两个独立维度：

```text
ignore：路径是否应从自动发现、遍历、搜索或索引中排除。
路径解析：把相对或绝对输入交给文件系统操作。
```

`.piignore` 和 `.gitignore` 不是访问控制机制。`ls` / `find` / `grep` / `read` / `write` / `edit` 接受相对或绝对路径；只要 Pi 进程和操作系统允许访问，就可以执行。相对路径按当前 `cwd` 解析；workspace 内绝对路径按 workspace-relative path 返回；workspace 外绝对路径保持绝对。

状态行为：

* 普通路径：`ls` 返回，`find` / `grep` 可搜索，`read` 允许，`write` / `edit` 允许。
* soft ignored：`ls` 返回并标记，显式 `read` 允许，`write` / `edit` 允许，`find` 默认跳过。
* cwd 外路径：允许访问；不套用当前 cwd 的 ignore 规则。
* blocked path：父目录 `ls` 隐藏，直接 `ls` / `find` / `grep` / `read` / `write` / `edit` 拒绝或跳过。

## file-tools 配置

用户配置：

```text
~/.pi/agent/configs/file-tools.jsonc
```

项目配置：

```text
.pi/configs/file-tools.jsonc
```

项目配置会在用户配置之后加载，只能：

* 追加 `blocked_path` 和 `ignored_path`；
* 覆盖 `limits`；
* 覆盖 `ignore.builtin_profile`。

项目配置不能修改 `ignore.piignore`、`ignore.gitignore` 或 `ignore.git_tracked_files_bypass`，避免项目关闭用户级 ignore 策略。

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
		"find_result_limit": 50,
		"find_max_entries_scanned": 100000,
		"grep_output_token_budget": 1600,
		"grep_result_limit": 8,
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

* `blocked_path`：硬阻止路径。命中后不可列出、搜索、读取或写入；相对规则可匹配同名路径段，绝对规则按绝对路径匹配。目录规则以 `/` 结尾。检查同时作用于输入解析后的 lexical path 和 `realpath`，因此 symlink 指向 blocked path 时也会被拒绝。
* `ignored_path`：软忽略路径。命中后 `ls` / `read` 返回 `ignored: true` 和 `ignore_source: "file-tools.jsonc"`，不阻止显式访问。
* `limits.ls_entries`：`ls` 单次最多返回条目数。
* `limits.read_lines`：`read` 单次最多返回行数。
* `limits.read_bytes`：`read` 单次最多返回 UTF-8 字节数。
* `limits.find_output_token_budget`：`find` 模型可见输出预算，按 [Token Counter](token-counter.md) 控制完整输出行。
* `limits.find_result_limit`：`find` 最多保留并返回的高排名具体结果。
* `limits.find_max_entries_scanned`：`find` 单次最多检查的文件系统条目数，达到后标记 `truncated`。
* `limits.grep_output_token_budget`：`grep` 模型可见输出预算，按 [Token Counter](token-counter.md) 选择正文、片段和签名。
* `limits.grep_result_limit`：`grep` 最多返回的代码区域数。
* `limits.grep_max_file_bytes`：`grep` 单个候选文件最大读取字节数，超出则跳过或显式报错。
* `limits.grep_max_files_scanned`：`grep` 单次最多扫描候选文件数，达到后结果标记为截断。
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

* `path`：目录路径。`.` 表示当前 `cwd`；相对路径按 `cwd` 解析；workspace 内绝对路径返回相对路径；workspace 外绝对路径保持绝对；空字符串非法。

模型可见成功结果使用紧凑 shell 风格文本，完整结构保留在 `details`：

```text
src 3
components/
index.ts
shared@ -> ../shared
```

entry：

* `name`：当前目录下的 basename。
* `path`：workspace 内路径返回 workspace-relative path；workspace 外路径返回规范化后的相对或绝对路径。
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
* 默认 `blocked_path` 包含 `.git/`，因此 `.git` 隐藏且不能直接 `ls`、`find`、`grep`、`read`、`write` 或 `edit`。

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

模型可见成功结果是紧凑文本，完整结构保留在 `details`：

```xml
<read path="src/main.ts" lines="1-80/240" more="81">
...content...
</read>
```

非默认状态才进入模型文本：`ignored`、`bom`、`newline`、`more`/`truncated` 和 LSP 摘要。`encoding: utf-8`、`bom: false`、版本和文件大小等默认或内部字段只保留在 `details`。

`details` 包括：

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

`find` 是单入口路径定位器，不读取正文、不解析 AST、不搜索 symbol、不修改文件。它同时返回普通文件和目录；目录结果以 `/` 结尾展示。

参数：

```json
{
	"path": "src",
	"query": "auth service"
}
```

字段：

* `path`：搜索根目录，默认 `.`。相对路径按 `cwd` 解析；workspace 内绝对路径会折叠为 workspace-relative path；workspace 外绝对路径保持绝对。
* `query`：相对于 `path` 解释的文件名、目录名、路径片段或 glob；绝对路径会先折叠为相对 `path` 的路径，不能逃出搜索根；空字符串非法。

成功结果是紧凑文本：

```text
5 matches · 4 files · 1 directory

src/auth/
src/auth/service.ts
src/auth/auth-service.ts
packages/api/src/auth-service.ts
tests/auth/service.test.ts
```

宽结果优先展示全局 top matches，再按高排名目录折叠剩余路径：

```text
90 matches · 90 files

Top matches:
a/file-00.ts
b/file-00.ts
c/file-00.ts

Other matches:
a/** (29 files)
b/** (29 files)
c/** (29 files)
```

行为：

* 先检查 `path/query` 是否是存在的文件或目录；命中 visible exact path 时直接返回，不扫描完整目录树。
* exact 未命中且 `query` 含有效 glob 语法时执行 glob；`src/**/*.ts` 与 `path=src, query=**/*.ts` 等价。
* 其他查询按名称、stem、路径 segment、路径片段和 Fuse.js tokenized fuzzy path 排序。
* tokenization 覆盖 `/`、`.`、`-`、`_`、camelCase、PascalCase 和字母/数字边界。
* 普通名称查询使用 smart case：全小写大小写不敏感，含大写时精确大小写结果优先。
* 多词查询先要求主要 token 全覆盖；无结果时才放宽覆盖率并给最多三个 nearby 建议。
* 排序优先 exact path、basename、stem、segment、basename prefix/substring、token 覆盖、ordered/fuzzy path，再按短路径、浅深度和字典序稳定排序。
* workspace 内结果路径相对 workspace root，统一使用 `/`；workspace 外显式搜索路径返回规范化后的相对或绝对路径。
* 文件和目录 symlink 均不返回；目录 symlink 不进入。
* 目录遍历和目录结果分开处理：可 prune 的 ignored 目录不进入；因反向 include 不能 prune 的目录可进入但自身不返回。
* `blocked_path` 命中时拒绝或跳过；`.git/` 默认不可查。
* 输出预算、返回结果数和最大扫描条目数由 `~/.pi/agent/configs/file-tools.jsonc` 和 `.pi/configs/file-tools.jsonc` 的 `limits` 控制，不暴露为工具参数。

## grep

`grep` 只按内容、symbol、正则或代码意图检索代码，不查找路径、不修改文件。结果按函数、方法、类、声明或紧凑文本片段聚合。

参数：

```json
{
	"query": "AuthService.login",
	"path": "src",
	"match": "auto",
	"glob": "**/*.{ts,tsx}"
}
```

字段：

* `query`：要查找的文本、symbol、qualified symbol、显式正则或自然语言代码意图。
* `path`：目录或普通文件；默认 `.`。相对路径按 `cwd` 解析，绝对路径可指向 workspace 外；目录递归检索，文件只检索该文件。
* `match`：`auto`、`literal` 或 `regex`；默认 `auto`。
* `glob`：相对 `path` 的 glob，只进一步缩小候选文件范围；ignore、symlink 和 `blocked_path` 仍由工具统一处理。

模式：

* `auto`：组合精确 qualified symbol、精确 symbol、symbol 前缀、字面量 occurrence、词法相关性和一跳 caller/callee/import 关系；不会猜测正则。
* `literal`：区分大小写的精确字符串搜索，同一 code unit 内多次命中合并为一个 region。
* `regex`：显式正则搜索；无效正则返回 `INVALID_REGEX`。

成功输出是紧凑文本，不是冗长 JSON：

```xml
<grep query="AuthService.login" path="src" match="auto" strategy="symbol+lexical" regions="6" files="4">

src/auth/service.ts:41-88
AuthService.login [definition · exact symbol]
calls: verifyPassword, issueToken

async login(credentials: Credentials) {
	...
}

src/auth/token.ts:14
issueToken [callee]
</grep>
```

行为：

* TypeScript、TSX、JavaScript、JSX、Python、Go、Rust 使用 `tree-sitter` 官方 grammar 提取函数、方法、类、接口/trait、类型/枚举、模块和顶层声明。
* 不支持或解析失败的语言退化为文本搜索和紧凑行窗口，不让整个调用失败。
* 每次调用创建 ignore snapshot；目录遍历使用 ignore `index` intent，ignored 文件不进入索引。
* 进程内按调用 `cwd` 缓存索引。缓存保存范围、signature、token 和关系元数据，不永久保存完整源码；返回源码时重新读取排名靠前的文件。
* 文件 fingerprint 使用 size、mtime 和内容 hash；新增、修改、删除和 ignore 变化会在后续调用中更新。
* 普通 dotfile 可检索；`.git/` 等 `blocked_path` 不可检索。
* 递归时不跟随文件或目录 symlink；显式 `path` 可指向 workspace 外。
* 二进制、非法 UTF-8、超大文件和局部权限失败在递归检索中计入 `skipped_files`；显式检索单个文件时返回对应错误。
* 结果按相关性排序：精确 qualified symbol、精确 symbol、定义、字面量、词法相关性、关系接近度、路径相关性；测试文件默认降权，查询含 test/spec 时取消降权。
* 输出由 `grep_output_token_budget` 控制，默认最多两个完整 body；其余候选优先输出路径、范围、symbol、signature 和少量关系。
* 超大函数不会吞掉全部预算，会保留 signature、命中附近片段和省略标记。
* 零结果是 `success`，auto 可返回少量相近 symbol 名称。

无效正则、路径错误、权限错误、取消和索引基础设施错误不会伪装成零匹配。

## write

`write` 创建或完整覆盖一个 UTF-8 文件，并自动创建缺失父目录。

参数：

```json
{
	"path": "src/new-file.ts",
	"content": "export const value = 1;\n"
}
```

行为：

* `path` 可为相对或绝对路径。
* 文件不存在时创建；文件存在时完整覆盖。
* 不要求先 `read`，也不更新 `read` 的版本缓存。
* soft ignore 不阻止 `write`；`blocked_path` 会拒绝写入。写入前会检查目标 lexical path、最近已存在父目录 realpath，以及已存在目标文件 realpath，避免通过 symlink 或 symlink parent 绕过。
* 写入机制与 Pi 内置 `write` 相同，使用普通 UTF-8 文件写入，不提供事务或回滚。
* `details.diff` 保存写入前后 diff，TUI 折叠态默认展示；模型可见成功结果不包含 diff。

模型可见成功结果只确认写入路径和 LSP 状态：

```xml
<write path="src/a.ts" lsp="clean"/>
```

如果 LSP 返回 errors/warnings，则附最多 5 条诊断，剩余用计数省略：

```xml
<write path="src/a.ts" lsp="errors">
errors=2 warnings=1 new_errors=1 new_warnings=0
diag error 12:5 Cannot find name 'foo'. (TS2304)
diag warning 30:7 'bar' is declared but never used.
... 4 more diagnostics
</write>
```

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

`read` 会在当前 session 记录文件版本；`edit` 自动使用该版本校验写入前内容。如果文件未读过，`edit` 返回 `READ_REQUIRED` 和 `error.next`。如果磁盘内容已变化，`edit` 返回 `STALE_READ` 和 `error.next`，不会自动合并或覆盖外部修改。

soft ignore 不阻止 `edit`。`edit` 只依据文件系统访问结果、文件类型、上次读取版本和 operation 合法性决定是否修改。

TUI 会在参数完整后执行只读预览并在 call 区显示 diff；真正执行仍必须通过 read-before-edit 和版本校验。成功后如果结果 diff 与预览一致，结果区不重复展示 diff。

模型可见成功结果只确认写入事实：

```xml
<edit path="src/main.ts" replacements="2" first_changed_line="81"/>
```

成功结果的 `diff` 是 Pi TUI 展示用的精简行号 diff，`firstChangedLine` 保存首个变更行号；模型可见正文不包含版本字段或完整 diff。

## 路径解析

`ls`、`find`、`grep`、`read`、`write`、`edit` 共享同一组路径规则。

路径先按当前 `cwd` 解析。工具只主动拒绝：

* 空路径；
* 空字节；
* 命中 `blocked_path`。

路径可以是相对路径、`..` 路径、绝对路径、包含 glob 字符的普通文件名，或指向 cwd 外的符号链接。工具不会展开 glob。

`blocked_path` 检查分两层：

* lexical path：对输入按 `cwd` 解析后的绝对路径、展示路径和 workspace-relative path 检查。
* realpath：对已存在目标的真实路径检查；`write` 还检查最近已存在父目录的真实路径，覆盖已有文件时检查目标真实路径。

symlink 本身允许存在和访问，但 symlink 指向 `blocked_path` 时拒绝。工具不要求 realpath 位于 workspace 内。

模型可见失败结果统一为紧凑错误标签，完整错误结构保留在 `details`：

```xml
<error tool="read" code="FILE_NOT_FOUND">
File does not exist.
</error>
```

如果错误带恢复提示，会追加 `next:` 行。

常见错误：

* `PATH_NOT_FOUND`：`ls` 目标目录不存在。
* `FILE_NOT_FOUND`：`read` 目标文件不存在。
* `NOT_A_DIRECTORY`：`ls` 目标存在但不是目录。
* `NOT_A_FILE`：`read` 目标存在但不是普通文件。
* `PROTECTED_PATH`：目标命中 `blocked_path`。
* `CONFIG_ERROR`：`file-tools.jsonc` 或 schema 无法读取、JSONC 语法错误、不符合 schema，或项目配置修改了只允许用户级控制的字段。
* `ACCESS_DENIED`：运行时无权访问目标。

恢复方式：

* `NOT_A_DIRECTORY`：改用 `read` 读取明确文件，或 `ls` 其父目录。
* `NOT_A_FILE`：改用 `ls` 浏览目录。
* `truncated: true`：继续 `ls` 更具体的子目录。
* `READ_REQUIRED`、`STALE_READ`：按 `error.next` 重新 `read`，基于最新内容生成新的 `edit` replacement。
* `OLD_TEXT_*`：重新 `read`，基于最新内容生成新的 `edit` replacement。
* 新文件或完整覆盖：使用 `write`；已有文件局部修改：先 `read`，再用 `edit`。
* 文件未出现在搜索/索引中：用 ignore snapshot 的 `explain` 查看 `winner.sourcePath` 和 `winner.line`。

## 提示词设计

工具提示词遵循最小 token 原则：协议约束尽量放进 schema 字段描述，系统提示词只保留关键决策规则。

当前文件类 agent tools 最终为：

```text
ls
find
grep
read
write
edit
```
