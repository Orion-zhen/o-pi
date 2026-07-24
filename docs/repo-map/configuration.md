# Repo Map 配置

Repo Map 配置使用 JSONC，并通过 schema 校验。当前配置结构只有 `scan`、`cache` 和 `output` 三组字段。

## 配置来源

默认配置文件名为：

```text
repo-map.jsonc
```

可以通过 `PI_REPO_MAP_CONFIG` 指定配置位置。加载失败会返回结构化 `CONFIG_ERROR`，不会使用部分无效配置继续扫描。

Repo Map 同时加载 File Tools 配置；后者提供 ignore 和 grep scan limits。两者不是同一份 schema。

## 字段

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

### `scan`

- `max_files`：最多纳入扫描的文件数，范围为 1–1,000,000。
- `max_file_bytes`：单文件最大字节数，范围为 1–100 MiB。
- `concurrency`：扫描和部分索引阶段的并发度，范围为 1–32。

### `cache`

- `max_generations`：每个 map 保留的 generation 数，范围为 1–10。

### `output`

- `read_context_token_budget`：读取上下文的输出预算。
- `mutation_impact_token_budget`：mutation impact 的输出预算。

两个 output budget 只影响渲染，不参与 generation fingerprint。

## 默认值和有效限制

源码内置默认值为：

- `max_files`: 100,000
- `max_file_bytes`: 1 MiB
- `concurrency`: 8
- `max_generations`: 2
- `read_context_token_budget`: 160
- `mutation_impact_token_budget`: 120

扫描最终限制还会与 File Tools 的 grep limits 取更严格值。仓库中的 `agent/configs/repo-map.jsonc` 可以覆盖内置 output budget；阅读实际配置时应以配置文件和 schema 为准。

## Fingerprint

Repo Map config fingerprint 包含 scan 和 cache 配置，不包含 output budget。服务再将 File Tools 配置合并计算 combined fingerprint，用于判断已有 generation 是否仍可复用。
