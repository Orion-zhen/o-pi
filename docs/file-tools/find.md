# `find`

`find` 是非交互式路径模糊查找工具。它只搜索文件名和路径，不读取正文或解析 AST，也不修改文件。参数包括 `query`、可选的 `path` 和可选的 `glob`。运行时固定大小写规则、匹配字段、条目类型、排序和结果限制。

## 参数

```json
{
  "query": "auth !test .ts$",
  "path": ["src", "packages"],
  "glob": "**/*.{ts,tsx}"
}
```

- `query`：必填的 fzf 扩展搜索查询，最长 512 个字符。
- `path`：可选的非空目录范围数组，默认为 `["."]`。多个范围取并集。
- `glob`：可选的候选路径 glob，相对每个范围解释。不含 `/` 时递归匹配基础名称。
- `glob` 只限制候选，系统不会从 `query` 推导 glob。
- 相对范围按 `cwd` 解析。工作区外明确指定的目录也可以作为搜索范围。

`tool-repair` 会将旧版单路径或分隔字符串迁移为数组。无法可靠迁移时，模式校验会拒绝输入。系统不会猜测真实路径。

## `query` 语法

普通查询词使用模糊子序列匹配。多个查询词采用 AND 关系。独立的 `|` 将相邻查询词组成 OR 关系：

| 查询 | 行为 |
| --- | --- |
| `auth service` | 同一路径同时模糊匹配 `auth` 和 `service` |
| `auth \| session` | `auth` 或 `session` |
| `'auth-service` | 精确匹配子串 |
| `'auth'` | 精确匹配单词或路径段边界 |
| `^src` | 精确匹配前缀 |
| `.ts$` | 精确匹配后缀 |
| `^src/auth.ts$` | 整条范围相对路径相等 |
| `!test` | 排除包含精确子串 `test` 的路径 |
| `!'tst` | 排除模糊匹配子序列 `tst` 的路径 |

`\` 转义下一个字符，因此 `auth\ service` 是一个包含空格的模糊查询词。每个查询词独立使用智能大小写。查询词没有大写字母时忽略大小写，出现大写字母时区分大小写。

`query` 不解释 glob。按扩展名筛选候选时，使用 `glob: "**/*.ts"`。需要让后缀参与 fzf 排名时，使用 `.ts$`。

## 候选与评分

文件系统路径发现能力先应用搜索范围、glob、受阻路径、软忽略规则、深度限制和符号链接规则。系统从已验证的父目录身份投影 `readdir` 已分类的普通文件和目录条目，不为每个条目读取元数据或执行 `realpath`。符号链接和未知类型仍会经过命名空间解析。目录按小批次预取，输出顺序保持确定。后续明确读取路径时，系统会重新解析并验证路径。

可见性求值器复用同一次目录枚举，按需发现并编译嵌套的 `.gitignore` 和 `.piignore`，不会在搜索前扫描整棵目录树。如果软忽略目录可能被尚未发现的嵌套高优先级规则重新包含，运行时会先检查该子树中的规则文件，再决定是否可以安全剪枝。

对于每个成功搜索的范围，系统使用遍历结果携带的范围相对路径为条目评分。输出仍使用规范化的展示路径。重复或嵌套范围不会产生重复候选。

排名算法固定为 `fzf-v2-path-v1`：

1. 字符按顺序匹配。
2. 连续字符以及路径段、单词、驼峰命名和数字边界获得奖励。
3. 字符间隔的起始和延续受到惩罚。
4. 多个查询词的分数相加，OR 分支采用最高分。
5. 分数相同时，依次优先基础名称命中数、较短匹配跨度、较短范围相对路径、范围顺序和路径字典序。

系统在每次调用中只编译一次查询词的 Unicode 和大小写形式。路径发现每产生一个唯一候选，系统就立即评分。运行时继续遍历并统计全部命中，但只维护不超过 `find_result_limit` 的相关性前缀。系统不会构造完整候选数组，也不会对限制外的命中执行全量排序。

运行时不接受 `case`、`exact`、`kind`、`field`、`scheme`、`sort` 或 `tiebreak` 参数。文件和目录统一搜索，始终启用路径匹配模式和智能大小写。

## 输出

模型正文按相关性顺序直接返回路径。目录以 `/` 结尾。结果不会折叠目录、混入附近的非命中项或显示分数：

```text
src/auth/service.ts
src/AuthService.ts
packages/api/src/auth-handler.ts
```

达到限制时，首行保留状态：

```text
matched=90 selected=50; truncated=depth_limit,result_limit,output_limit
```

`details.truncated_by` 只包含以下值：

- `depth_limit`：至少一个范围达到 `find_max_depth`。
- `entry_limit`：所有范围共享的遍历量达到 `find_max_entries`。
- `result_limit`：命中数超过 `find_result_limit`。
- `output_limit`：完整路径行超过 `find_output_token_budget`。

`details.matches` 保存结果限制应用后的完整选择。`displayed_matches` 只保存实际进入模型正文的路径。条目预算由运行时配置，模型参数不能放大该预算。`stats` 记录遍历、软忽略和跳过的条目数。排名分数不进入模型正文。

零结果示例：

```text
none
searched=42; ignored=3; skipped=0
next: refine query/path/glob
```

## 范围、忽略规则、符号链接与取消

自动发现默认不进入软忽略目录。将软忽略目录明确放入 `path` 后，可以搜索其中的内容。受阻路径始终拒绝访问。系统不会把文件或目录符号链接列为候选，也不会递归进入目录符号链接。

只要至少一个范围搜索成功，系统就会保留结果，并通过 `scope_errors` 和正文中的 `partial` 警告报告失败范围。全部范围失败时返回结构化错误。

调用信号、主机关闭信号和 `FindTool.dispose()` 信号会组合到同一操作上下文。路径发现会关闭迭代器。排名任务分批让出事件循环，并在候选边界检查取消。`FindTool` 不持有工作线程、索引或跨调用排名缓存。

## 失败

| 错误码 | 条件 |
| --- | --- |
| `INVALID_OPERATION` | `query` 为空、过长、包含 NUL、CR 或 LF，或 fzf 的 OR/操作符结构非法 |
| `INVALID_PATH` | `path` 或 `glob` 为空、包含 NUL 或换行，或结构非法 |
| `PATH_NOT_FOUND` | 范围不存在 |
| `NOT_A_DIRECTORY` | 范围不是目录 |
| `PROTECTED_PATH` | 范围被受阻路径策略阻止 |
| `ACCESS_DENIED` | 范围无法访问 |
| `OPERATION_ABORTED` | 调用或工具所有者被取消 |
| `CONFIG_ERROR` | 文件工具配置无效 |

公共路径、安全、输出和错误协议见[路径与安全](path-security.md)与[工具契约](contracts.md)。
