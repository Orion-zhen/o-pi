# Repo Map Scope 与 Ignore

Repo Map 的扫描范围由 repository identity、File Tools 配置和 immutable ignore snapshot 共同决定。

## Repository scope

扫描从 repository root 开始，并记录 worktree root 与 Git common directory。查询时请求路径必须位于已激活的 repository root 内；repository 外路径不会使用 Repo Map 结果。

## Ignore snapshot

Repo Map 复用 File Tools ignore engine：

1. 加载 File Tools 配置。
2. 从 repository root 创建 snapshot。
3. 用 snapshot 进行本次扫描。
4. 将 snapshot fingerprint 写入 generation metadata。

一次扫描期间 snapshot 不变，避免规则在扫描中途变化导致同一 generation 混合不同语义。

ignore 的完整优先级、反向规则、nested ignore、tracked set 和 explain 行为见 [File Tools ignore engine](../file-tools/ignore.md)。本页不重复定义匹配算法。

## 扫描限制

Repo Map 同时受到两层限制：

- `repo-map.jsonc` 的 `scan.max_files` 和 `scan.max_file_bytes`。
- File Tools `limits.grep_max_files_scanned` 和 `limits.grep_max_file_bytes`。

最终使用两者中更严格的值。超限文件会被计入 summary 或 diagnostics，不会被当作完整解析文件。

## 文件状态

扫描会区分：

- `indexed`：成功纳入索引。
- `too_large`：超过单文件大小限制。
- `unreadable`：读取失败。
- `unstable`：读取过程中内容变化，无法确认稳定身份。

不支持的语言和 parser 错误也会单独统计，便于判断图是否完整。

## Symlink 和安全边界

Repo Map 不绕过 File Tools 的路径安全检查。递归扫描不会把 symlink 当作新的目录树；symlink 指向的 blocked path 也不会因为经过索引而变得可访问。

ignore 是发现和索引策略，不是访问控制。明确读取路径时仍由 [File Tools 路径安全](../file-tools/path-security.md) 决定是否允许访问。
