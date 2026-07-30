# `find`

`find` 是非交互式路径 fuzzy finder。它只搜索文件名和路径，不读取正文、不解析 AST、不修改文件。公开参数保持为 query、可选 scope 和可选候选 glob；case、字段、kind、排序和结果限制均由 runtime 固定。

## 参数

```json
{
  "query": "auth !test .ts$",
  "path": ["src", "packages"],
  "glob": "**/*.{ts,tsx}"
}
```

- `query`：必填的 fzf extended-search query，最长 512 个字符。
- `path`：可选的非空目录 scope 数组，默认 `["."]`；多个 scope 是 OR/union。
- `glob`：可选的候选路径 glob，相对每个 scope 解释；不含 `/` 时递归匹配 basename。
- `glob` 只限制候选，永远不从 `query` 推断。
- 相对 scope 按 `cwd` 解析；workspace 外显式目录仍可作为 scope。

旧的单路径或分隔字符串由 tool repair 迁移为数组；无法可靠迁移时交给 schema 校验失败。

## Query 语法

普通 term 使用 fuzzy subsequence；多个 term 为 AND。独立的 `|` 将相邻 term 组成 OR：

| query | 行为 |
| --- | --- |
| `auth service` | 同一路径同时 fuzzy 匹配 `auth` 和 `service` |
| `auth \| session` | `auth` 或 `session` |
| `'auth-service` | exact substring |
| `'auth'` | exact word/path-segment boundary |
| `^src` | exact prefix |
| `.ts$` | exact suffix |
| `^src/auth.ts$` | 整条 scope-relative path 相等 |
| `!test` | 排除 exact substring `test` |
| `!'tst` | 排除 fuzzy subsequence `tst` |

`\` 转义下一个字符，因此 `auth\ service` 是一个包含空格的 fuzzy term。每个 term 独立使用 smart case：没有大写字母时忽略大小写，出现大写字母时区分大小写。

`query` 不解释 glob。按扩展名筛候选时使用 `glob: "**/*.ts"`；用 suffix 搜索并参与 fzf 排名时使用 `.ts$`。

## 候选和评分

filesystem path discovery 先应用 scope、glob、blocked path、soft ignore、深度和 symlink 规则。普通文件使用 `readdir` 目录项快照和已验证父目录 identity 投影，不为每个文件读取 metadata 或执行 `realpath`；目录、symlink 和未知类型仍在递归边界经过 namespace 解析。后续明确读取会重新解析并验证路径。

每个成功 scope 的 entry 使用 traversal 直接携带的 scope-relative path 评分，输出仍使用规范 display path；重复和嵌套 scope 不产生重复候选。

排名固定为 `fzf-v2-path-v1`：

1. 字符按顺序匹配；
2. 连续字符、路径段边界、单词边界和 camelCase/数字边界获得奖励；
3. gap 起始和延续受到惩罚；
4. 多 term 分数相加，OR 采用最佳分支；
5. 同分时依次优先 basename 命中数、较短 match span、较短 scope-relative path、scope 顺序和路径字典序。

query term 的 Unicode/case 形式每次调用只编译一次。runtime 统计全部命中，但只维护 `find_result_limit` 大小的 relevance 前缀，不对 limit 之外的命中执行全量排序。

runtime 不接受 case、exact、kind、field、scheme、sort 或 tiebreak 参数。文件和目录统一搜索，path scheme 和 smart case 始终启用。

## 输出

模型正文直接返回 relevance 顺序的具体路径；目录带 `/`。不折叠目录、不混入 nearby 非命中，也不显示 score：

```text
src/auth/service.ts
src/AuthService.ts
packages/api/src/auth-handler.ts
```

达到边界时首行保留状态：

```text
matched=90 selected=50; truncated=depth_limit,result_limit,output_limit
```

`details.truncated_by` 只包含：

- `depth_limit`：至少一个 scope 达到 `find_max_depth`；
- `result_limit`：命中超过 `find_result_limit`；
- `output_limit`：完整路径行超过 `find_output_token_budget`。

`details.matches` 保存 result limit 后的完整选择；`displayed_matches` 只保存实际进入模型正文的路径。`stats` 记录遍历、ignored 和 skipped entry 数；ranking score 不进入模型正文。

零结果：

```text
none
searched=42; ignored=3; skipped=0
next: refine query/path/glob
```

## Scope、ignore、symlink 和取消

默认自动发现不进入 soft ignored 目录；把 ignored 目录明确放进 `path` 后可以搜索其内容。blocked path 始终拒绝。文件和目录 symlink 均不作为候选，目录 symlink 不进入。

至少一个 scope 成功时保留结果，并通过 `scope_errors` 和正文中的 `partial` 警告报告失败 scope；全部 scope 失败时返回结构化错误。

invocation signal、host shutdown 和 `FindTool.dispose()` 组合进同一 operation context。discovery 会关闭 iterator；排名分批让出事件循环并在候选边界检查取消。`FindTool` 不持有 worker、索引或跨 invocation 排名缓存。

## 失败

| code | 条件 |
| --- | --- |
| `INVALID_OPERATION` | query 为空、过长、含 NUL/CR/LF，或 fzf OR/operator 结构非法 |
| `INVALID_PATH` | path/glob 为空、含 NUL/换行或结构非法 |
| `PATH_NOT_FOUND` | scope 不存在 |
| `NOT_A_DIRECTORY` | scope 不是目录 |
| `PROTECTED_PATH` | scope 被 blocked policy 阻止 |
| `ACCESS_DENIED` | scope 无法访问 |
| `OPERATION_ABORTED` | 调用或 tool owner 被取消 |
| `CONFIG_ERROR` | file-tools 配置无效 |

公共路径、安全、输出和错误协议见 [路径与安全](path-security.md) 与 [工具契约](contracts.md)。
