# Repo Map 图模型

Repo Map 将仓库表示为带 evidence 的有向图。节点描述实体，边描述关系，evidence 指向可以验证关系的源代码范围。

## 节点

### Repository

记录 repository root、worktree root 和 Git common directory。

### File

记录文件身份、路径、语言、大小和扫描状态。文件状态包括：

- `indexed`
- `too_large`
- `unreadable`
- `unstable`

### Symbol

记录 symbol 的范围、名称、qualified name、signature、visibility，以及：

- definitions
- references
- calls
- imports

### Architecture

架构节点包括：

- package
- component
- entrypoint

每个架构节点记录识别来源：`manifest`、`convention` 或 `syntactic`，并保留 confidence。

### Test

Test node 表示测试文件或测试 symbol。它附着在已有文件或 symbol 上，不替代被测试实体。

## 边

常见 edge kind：

| 类型 | 含义 |
| --- | --- |
| `contains` | 文件包含 symbol 或实体 |
| `belongs-to` | 实体属于 package/component |
| `imports` / `exports` | 模块导入、导出或重导出 |
| `references` | symbol 引用另一个实体 |
| `calls` | 调用关系 |
| `tests` | 测试与目标的关系 |
| `mocks` / `uses-fixture` / `uses-snapshot` | 测试辅助关系 |
| `registers-*` | command、tool、plugin 注册关系 |
| `configured-by` | 实体与配置项的关系 |

边还包含：

- `resolution`：`lexical`、`syntactic` 或 `semantic`。
- `source`：`tree-sitter`、`syntax`、`manifest`、`lsp` 或 `convention`。
- `confidence`。
- 一个或多个 evidence。

## Evidence

Evidence 由文件路径、起止范围和可选 text hash 组成。相同关系的重复 evidence 会被去重并稳定排序。

查询结果应该优先返回带 evidence 的关系；没有可验证 evidence 的候选不能被渲染成确定命中。

## Alias

Alias 用于把用户查询词映射到 repository-derived target。来源包括：

- file path
- symbol 和 signature
- import/export alias
- architecture
- registration
- config key
- environment
- doc comment

固定缩写只使用小范围 canonical table；普通 alias 不通过外部模型生成。

更具体的语言解析、架构、测试和 alias 提取规则见 [parsing-and-relations.md](parsing-and-relations.md)。

## 稳定性

节点、边、evidence、alias 和 diagnostics 都使用显式稳定排序。generation 不依赖 Map 插入顺序或并发完成顺序，因此相同输入可以产生可比较的结果。
