# `find`

`find` 是单入口路径定位器，不读取正文、不解析 AST、不搜索 symbol、不修改文件。它同时返回普通文件和目录；目录结果以 `/` 结尾展示。

## 参数

```json
{
  "path": ["src", "tests"],
  "query": "*.{ts,tsx}"
}
```

- `path` 是可选的非空搜索根目录数组，默认 `["."]`。
- 多个 path 是 OR/union scope；所有 scope 共享同一个 query，不是 AND，也不是笛卡尔积。
- `query` 可以是文件名、目录名、路径片段、概念或 glob。
- 相对路径按 `cwd` 解析；workspace 内绝对路径折叠为 workspace-relative path；workspace 外绝对路径保持规范化形式。
- `path: []`、空元素和空 query 非法。
- glob 字符不会逃出搜索根。

旧的单路径或逗号/空白/换行分隔字符串由 `tool-repair` 迁移为数组；无法可靠解析或超过最大路径数时不猜测，交给 schema 校验失败。

## 查询模式

### 精确路径

工具先检查 `path/query` 是否是存在的文件或目录。命中 exact path 时直接返回，不扫描完整目录树；soft ignore 不阻止明确的 exact 命中。

### Glob

glob query 进入严格路径匹配，不查询 Repo Map：

- 无 `/` 的模式递归匹配每层 basename，因此 `*.py` 可以命中任意深度；
- 带 `/` 的模式匹配相对搜索路径；
- 静态前缀会缩小遍历范围；
- `path=src, query=*.ts` 与 `query=src/**/*.ts` 等价。

### 普通查询

非 glob query 用于路径召回、相关性排序和可选 Repo Map 语义召回。tokenization、smart case、tier、证据融合和多样性选择见 [排序总览](ranking.md)。

## 输出

窄结果只返回路径：

```text
src/auth/
src/auth/service.ts
src/auth/auth-service.ts
packages/api/src/auth-service.ts
tests/auth/service.test.ts
```

宽结果保留 ranking 顺序，并按目录折叠剩余路径：

```text
top:
a/file-00.ts
b/file-00.ts
c/file-00.ts
other:
a/** (29 files)
b/** (29 files)
c/** (29 files)
```

`scanTruncated`、`resultLimited` 和 `outputTruncated` 分别表示扫描未完成、具体结果受数量限制和模型文本受 token budget 限制。状态会放在首行，不能被尾部裁剪：

```text
found=90 selected=50; truncated=result
```

## Scope、ignore 和 symlink

多个 scope 统一排序并按规范化相对路径去重；重复或嵌套 scope 不会重复条目。所有 scope 共享结果数量、扫描条目数和模型 token 预算。

至少一个 scope 成功时保留有效条目，并在 `details.scope_errors` 及模型输出中标注失败 scope；所有 scope 失败时返回结构化错误。

默认可 prune 的 ignored 目录不进入。因反向 include 不能 prune 的目录可以进入但自身不返回；显式 `path` 或 glob 静态前缀命中 ignored 目录时允许在其中查找。文件和目录 symlink 均不返回，目录 symlink 不进入。blocked path 会拒绝或跳过。

## 零结果

零结果仍以 `none` 开头。名称 typo 或 fuzzy query 有可信候选时，最多追加 3 条独立的 `<nearby nonmatch>`；这些条目不计入主结果，也不放宽主结果语义：

```text
none
<nearby nonmatch>
src/auth/service.ts [name similarity]
</nearby>
```

若无可信邻近项或 Repo Map 关联项，则返回 `searched`、`ignored`、`skipped` 摘要和 `next` 提示。glob 缺少静态前缀时优先提示 `missing prefix` 和 `near dir`。相关通道的边界见 [排序选择](ranking-selection.md)。

## 限制

输出预算、结果数和扫描条目数由 file-tools 配置控制，不暴露为工具参数。达到扫描上限时标记 `scanTruncated`；达到具体结果上限时标记 `resultLimited`。路径安全、配置错误和恢复方式见 [路径与安全](path-security.md) 和 [配置](configuration.md)。
