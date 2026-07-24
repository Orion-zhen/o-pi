# Repo Map

Repo Map 是当前仓库的代码结构索引。它把文件、symbol、import/export、调用关系、测试关系和部分架构信息组织成可查询的图，为 `find`、`grep`、`read` 和 mutation impact 提供可选增强。

Repo Map 不是源代码的替代品，也不是完整构建系统。需要确认当前文件内容时仍然使用 `read`；需要精确文本搜索时仍然使用 `grep`。

## 快速选择能力

| 需求 | 首选能力 | 说明 |
| --- | --- | --- |
| 了解项目结构 | Repo Map | 查看 package、component、entrypoint 和关系 |
| 查 symbol 或调用关系 | Repo Map + `grep` | Repo Map 负责召回，`grep` 返回可验证代码区域 |
| 搜索精确文本 | `grep` | 以实时文件内容命中为准 |
| 按名称或路径找文件 | `find` | 不读取文件正文 |
| 确认当前实现 | `read` | 结果不依赖索引是否新鲜 |
| 评估修改影响 | Repo Map | 提供引用、调用、测试和相关上下文 |

## 常用操作

Repo Map 通过 `/init` 命令管理：

| 命令 | 行为 |
| --- | --- |
| `/init` | 初始化或加载当前仓库的 Repo Map |
| `/init status` | 查看当前激活状态 |
| `/init refresh` | 基于已有 generation 增量刷新 |
| `/init rebuild` | 丢弃可复用 generation 后重建 |
| `/init off` | 当前 session 禁用自动激活 |

通常只需在仓库中执行一次 `/init`。session 启动时会轻量发现已有 Repo Map；没有建立过索引的仓库不会因为自动发现而扫描。

初始化完成后，文件工具会按查询类型使用 Repo Map：

```text
探索仓库：       ls → find → read
查找实现：       grep(auto) → read
查 symbol 关系：  Repo Map → grep/read 验证
修改文件后：     mutation → 串行 refresh
```

## Repo Map 包含什么

索引由多个互相连接的节点和边组成：

- **文件**：路径、语言、大小、内容状态和文件身份。
- **symbol**：名称、qualified name、签名、定义、引用、调用和 import 信息。
- **架构**：package、component 和 entrypoint。
- **测试**：测试文件或测试 symbol，以及它们测试的目标。
- **关系**：`imports`、`exports`、`references`、`calls`、`tests`、注册关系和配置关系。
- **别名**：从路径、symbol、signature、registration 或配置中提取的可搜索词。

关系会保留来源、解析方式、confidence 和 evidence。查询结果因此可以回到具体文件和代码范围，而不是只返回不可验证的抽象分数。

## 结果是否可信

每个 generation 都有 freshness 状态：

| 状态 | 含义 | 一般处理 |
| --- | --- | --- |
| `fresh` | 与当前仓库、配置和 parser 版本一致 | 可以使用结构结果 |
| `partially_stale` | 索引可用，但部分文件或解析步骤有问题 | 使用时查看 diagnostics，并用 `read` 验证 |
| `stale` | Git revision、配置、ignore 或 parser 已变化 | `/init refresh` |
| `unavailable` | generation 不存在、损坏或不能读取 | `/init rebuild` 或使用基础文件工具 |

Repo Map 不会用旧索引替代实时文件内容：

- `read` 始终读取当前文件。
- `grep(literal/regex)` 的主命中以当前正文为准。
- Repo Map 只作为结构召回、关系上下文和影响分析来源。
- 解析失败、超大文件、权限错误和不支持的语言会记录 diagnostics。

## 扫描范围和 ignore

扫描以当前 repository root 为边界。Repo Map 使用 File Tools 的 ignore 配置创建 immutable snapshot：

- `.gitignore`、`.piignore` 和 builtin 规则会影响自动扫描。
- soft ignored 文件不会进入自动索引，但这不是访问控制。
- blocked path 仍由文件工具的路径安全规则独立处理。
- `.git/` 默认属于 blocked path。
- 超过文件数量或文件大小限制的内容不会被静默当成完整索引。

ignore 规则的完整定义见 [File Tools ignore engine](../file-tools/ignore.md)；Repo Map 如何使用 snapshot 和 fingerprint 见 [scope-and-ignore.md](scope-and-ignore.md)。

## 何时刷新

下列变化会使已有 generation 变旧：

- 工作树的 Git revision 变化。
- 文件新增、删除、内容变化或文件身份变化。
- File Tools ignore 规则变化。
- Repo Map 或 File Tools 配置变化。
- parser/index format 变化。
- 仓库在扫描期间继续发生变化。

`refresh` 会尽量复用未变化文件和解析结果；`rebuild` 用于 generation 损坏、schema 变化或需要完全重新建立索引的场景。更新操作按 map 串行化，避免较旧的工作区快照覆盖较新的 generation。

## 输出和限制

Repo Map 查询会根据用途返回有限上下文：

- `read` 上下文包含相关 symbol、关系和 evidence。
- mutation impact 只返回预算内的影响摘要。
- 候选收集和最终输出都有上限。
- token budget 截断不等于查询失败。
- 完整 metadata、diagnostics 和统计信息保留在结构化结果中。

当 Repo Map 没有可用结果时，`find`、`grep` 和 `read` 仍然可以执行基础路径扫描、实时文本搜索和文件读取。

## 配置概览

Repo Map 配置文件为 `repo-map.jsonc`，默认配置包括：

```jsonc
{
  "scan": {
    "max_files": 100000,
    "max_file_bytes": 1048576,
    "concurrency": 8
  },
  "cache": {
    "max_generations": 2
  },
  "output": {
    "read_context_token_budget": 160,
    "mutation_impact_token_budget": 120
  }
}
```

实际配置可以通过 `PI_REPO_MAP_CONFIG` 指定。扫描上限还会受到 File Tools 的 `grep` limits 约束。完整 schema、默认值和 fingerprint 规则见 [configuration.md](configuration.md)。

## 可选增强和退化边界

Repo Map 是 File Tools 的内部增强，不会增加额外的模型可见工具：

- `find` 可以使用 Repo Map 的路径和架构候选。
- `grep` 可以使用 symbol、结构和关系候选。
- `read` 可以请求 symbol 或关系上下文。
- mutation 后可以触发影响分析和 refresh。
- LSP 是独立的可选增强，不是 Repo Map 的必要依赖。

Repo Map 未初始化、过期、超时或加载失败时，基础文件操作和文本搜索仍然可用。详细边界见 [integration.md](integration.md)。

## 深入阅读

| 主题 | 文档 |
| --- | --- |
| 系统边界和模块职责 | [architecture.md](architecture.md) |
| session 激活、懒加载和状态 | [lifecycle.md](lifecycle.md) |
| 节点、边、evidence 和 alias | [graph-model.md](graph-model.md) |
| 扫描和索引流水线 | [indexing-pipeline.md](indexing-pipeline.md) |
| scope、ignore snapshot 和跳过规则 | [scope-and-ignore.md](scope-and-ignore.md) |
| 配置字段和加载方式 | [configuration.md](configuration.md) |
| freshness、fingerprint 和 generation | [freshness.md](freshness.md) |
| 查询、传播和排序 | [query-and-ranking.md](query-and-ranking.md) |
| 语言解析、架构和测试关系 | [parsing-and-relations.md](parsing-and-relations.md) |
| 查询、上下文和输出预算 | [output-and-query.md](output-and-query.md) |
| 与 File Tools、LSP 的集成 | [integration.md](integration.md) |
| `/init` 和故障恢复 | [operations.md](operations.md) |
| 持久化、校验和错误恢复 | [storage-and-errors.md](storage-and-errors.md) |
| 性能、缓存和 benchmark | [performance.md](performance.md) |
