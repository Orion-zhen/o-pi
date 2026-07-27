# 配置

本文说明 file-tools 配置的路径、优先级、字段和缓存。工具行为摘要见 [文件工具设计](README.md)，ignore 匹配算法见 [Ignore engine](ignore.md)。

## 配置位置与优先级

默认配置：

```text
~/.pi/agent/defaults/file-tools.jsonc
```

用户配置：

```text
~/.pi/agent/configs/file-tools.jsonc
```

项目配置：

```text
.pi/configs/file-tools.jsonc
```

配置按默认、用户、项目顺序合并。项目配置按每次 Pi invocation 的 `ctx.cwd` 定位，而不是按 agent 进程的 `process.cwd()` 隐式选择。它在用户配置之后加载，但只能：

- 追加 `blocked_path` 和 `ignored_path`；
- 覆盖 `limits`；
- 覆盖 `ignore.builtin_profile`。

项目配置不能修改 `ignore.piignore`、`ignore.gitignore` 或 `ignore.git_tracked_files_bypass`，避免项目关闭用户级 ignore 策略。

## 默认配置

完整默认值以 `agent/defaults/file-tools.jsonc` 为准。默认文件必须包含 schema 中的全部固定字段；缺失或损坏会作为配置错误处理，不再回退到 TypeScript 常量。

## 字段

### 路径策略

- `blocked_path`：硬阻止路径。命中后不能列出、搜索、读取或写入。相对规则可匹配同名路径段，绝对规则按绝对路径匹配；目录规则以 `/` 结尾。输入 lexical path 和目标 realpath 都会检查。
- `ignored_path`：soft ignore 路径。自动发现、递归搜索和索引默认跳过；明确访问仍然允许，并返回 `ignored: true` 及 `ignore_source: "file-tools.jsonc"`。

### limits

- `ls_entries`：一次 `ls` 最多返回的直属成员数。
- `read_lines` / `read_bytes`：一次 `read` 最多返回的行数和 UTF-8 字节数。
- `read_max_file_bytes`：`read` 可完整载入的单文件上限；局部行范围也不能绕过。
- `write_max_file_bytes`：`write` 的已有 snapshot 和提交内容上限。
- `edit_max_file_bytes`：`edit` 的已有 snapshot 和提交内容上限。
- `edit_match_hint_limit`：`OLD_TEXT_NOT_UNIQUE` 匹配提示或 `OLD_TEXT_NOT_FOUND` anchor 候选的最大返回数，默认 3，范围为 1-10。
- `find_output_token_budget`：`find` 模型可见输出预算，最小为 32 token。
- `find_result_limit`：`find` 最多保留的具体结果数。
- `find_max_entries_scanned`：`find` 最多扫描的文件系统条目数。
- `grep_max_entries_traversed`：`grep` 在所有 scope 中最多遍历的文件系统条目数。
- `grep_max_text_bytes_scanned`：`grep` 单次事实文本扫描的全局字节预算。
- `grep_max_text_file_bytes`：`grep` 可流式扫描的单文件硬上限。
- `grep_max_files_parsed`：最多进入语法解析的候选文件数；不限制事实文本命中。
- `grep_max_parse_file_bytes`：单文件进入 Tree-sitter 的最大字节数。
- `grep_output_token_budget`：`grep` 模型可见输出预算。
- `grep_result_limit`：`grep` 最多返回的代码区域数。

`find` 和 `grep` 的输出预算按 [Token Counter](../token-counter.md) 控制，不作为工具参数暴露给模型。

### ignore

- `piignore`：是否读取 `.piignore`。
- `gitignore`：是否读取 `.gitignore`。
- `git_tracked_files_bypass`：tracked 文件是否绕过 `.gitignore`；不会绕过 `.piignore`。
- `builtin_profile`：内置 soft ignore profile，可取 `none`、`minimal` 或 `performance`。

## 运行时配置

内部 ignore 配置的默认值为：

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

规则来源优先级从高到低为：session override、`.piignore`、`.gitignore`、`.git/info/exclude`、Git global excludes、builtin rules。后两类默认关闭。

## 校验、分层与缓存

配置损坏时 host 返回 `CONFIG_ERROR`，不会创建 filesystem namespace 或继续 workspace I/O。loader 将结果拆为 filesystem policy（blocked/visibility）和只读 tool limits；filesystem 不接收搜索、模型输出或增强配置，tool command 只接收自身所需 limits。

有效配置按用户/项目路径和文件 metadata 缓存在进程内；同 cwd 并发调用共享读取和 schema 校验，不同 cwd 不共享错误或项目配置。配置文件创建、替换或修改后 fingerprint 变化，下一次调用自动重载。

每次调用获得独立冻结/克隆后的配置值，调用方不能污染缓存。配置和 visibility snapshot 的关系见 [Ignore engine](ignore.md)。
