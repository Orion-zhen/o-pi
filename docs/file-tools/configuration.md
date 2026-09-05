# 配置

本文说明文件工具的配置路径、优先级、字段和缓存。工具行为摘要见[文件工具设计](README.md)，忽略规则匹配算法见[忽略规则引擎](ignore.md)。

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

配置按默认、用户、项目顺序合并。项目配置按每次 Pi 调用的 `ctx.cwd` 定位，而不是按智能体进程的 `process.cwd()` 隐式选择。它在用户配置之后加载，但只能：

- 追加 `blocked_path` 和 `ignored_path`。
- 覆盖 `limits`。
- 覆盖 `ignore.builtin_profile`。

项目配置不能修改 `ignore.piignore`、`ignore.gitignore` 或 `ignore.git_tracked_files_bypass`。此限制可防止项目关闭用户级忽略策略。

## 默认配置

完整默认值以 `agent/defaults/file-tools.jsonc` 为准。默认文件必须包含模式要求的全部字段。字段缺失或文件损坏会作为配置错误处理，不再回退到 TypeScript 常量。

## 字段

### 路径策略

- `blocked_path`：硬阻止路径。系统不能列出、搜索、读取或写入命中的路径。相对规则可匹配同名路径段，绝对规则按绝对路径匹配。目录规则以 `/` 结尾。系统同时检查输入的字面路径和目标的真实路径。默认规则还阻止 SSH 私钥、常见云端认证文件、包管理认证文件和常用 `.env` 文件。
- `ignored_path`：软忽略路径。自动发现、递归搜索和索引默认跳过命中的路径。明确访问仍然允许，结果会包含 `ignored: true` 和 `ignore_source: "file-tools.jsonc"`。

### `limits`

- `ls_entries`：一次 `ls` 最多返回的直属成员数。
- `read_lines` / `read_bytes`：一次 `read` 最多返回的行数和 UTF-8 字节数。
- `read_max_file_bytes`：`read` 可完整载入的单文件上限。局部行范围和 PDF 页面范围都不能绕过。
- `read_pdf_pages`：一次 `read` 最多渲染并返回的 PDF 页面数。默认配置为 20，取值范围为 1 到 100。显式的 `pages` 范围不能绕过。
- `read_suggestion_limit`：文件不存在时最多返回的相关路径数。默认配置为 3，取值范围为 1 到 10。
- `write_max_file_bytes`：`write` 的现有文件快照和提交内容上限。
- `edit_max_file_bytes`：`edit` 的现有文件快照和提交内容上限。
- `edit_match_hint_limit`：`OLD_TEXT_NOT_UNIQUE` 匹配提示或 `OLD_TEXT_NOT_FOUND` 锚点候选的最大返回数。默认配置为 5，取值范围为 1 到 10。
- `find_output_token_budget`：`find` 模型可见输出的词元预算，最小值为 32。
- `find_result_limit`：`find` 最多保留的具体结果数。
- `find_max_depth`：`find` 相对每个搜索范围的最大路径深度。范围根目录的深度为 0，直属子项为 1。
- `find_max_entries`：一次 `find` 在所有范围间共享的最大遍历条目数，默认 20000。
- `grep_max_depth`：`grep` 相对每个明确范围的最大路径深度。范围根目录的深度为 0，直属子项为 1。
- `grep_max_entries`：一次 `grep` 文件清单构建在所有目录范围间共享的最大遍历条目数，默认 10000。
- `grep_max_search_bytes`：一次 `grep` 正文搜索可预留的累计文件快照字节数，默认配置为 128 MiB。下一文件无法完整容纳时停止扫描。
- `grep_ast_max_file_bytes`：单文件进入 Tree-sitter 的最大字节数。不限制流式正文搜索。
- `grep_content_cache_bytes`：进程内 `grep` 正文缓存的总字节上限，默认配置为 16 MiB，取值范围为 0 到 100 MiB。`0` 表示禁用。
- `grep_content_cache_entries`：进程内 `grep` 正文缓存的文件数上限，默认配置为 2048，取值范围为 0 到 100000。`0` 表示禁用。
- `grep_result_limit`：`grep` 最多返回的区域数。
- `grep_related_result_limit`：稳定排序后最多保留的相关区域数，默认配置为 8，取值范围为 0 到 50。`0` 表示禁用相关结果。模型输出不会提示该限制，截断信息也不包含该限制。
- `grep_regional_display_limit`：每个语法区域最多展示的匹配或证据源码行数，默认配置为 3，取值范围为 1 到 20。不裁剪完整的 `match_lines` 记录。

配置只接受以上列出的 `grep_` 限制字段。`grep_max_entries` 限制文件清单构建，`grep_max_search_bytes` 限制正文扫描。`grep_ast_max_file_bytes` 只控制单个文件的语法增强。正文缓存限制只控制跨调用复用。系统先应用相关结果上限，但不在模型输出中提示该限制。剩余候选再受 `grep_result_limit` 限制。

### `ignore` 字段

- `piignore`：是否读取 `.piignore`。
- `gitignore`：是否读取 `.gitignore`。
- `git_tracked_files_bypass`：已跟踪文件是否绕过 `.gitignore`。不会绕过 `.piignore`。
- `builtin_profile`：内置软忽略档位，可取 `none`、`minimal` 或 `performance`。

## 校验、分层与缓存

配置损坏时，主机返回 `CONFIG_ERROR`，不会创建文件系统命名空间或继续访问工作区。加载器先校验并合并各层原始值，再一次性构建文件系统策略、工具限制和最终指纹，不生成中间策略。文件系统策略只包含受阻路径和可见性规则。文件系统不接收搜索、模型输出或增强配置，各工具命令只接收自身需要的限制。

系统根据用户配置路径、项目配置路径和文件元数据，在进程内缓存有效配置。同一 `cwd` 的并发调用共享文件读取和模式校验结果。不同 `cwd` 不共享错误或项目配置。创建、替换或修改配置文件会改变指纹，下一次调用将自动重新加载配置。

每次调用获得经过独立冻结或克隆的配置值，调用方不能污染缓存。配置和调用级可见性状态的关系见[忽略规则引擎](ignore.md)。
