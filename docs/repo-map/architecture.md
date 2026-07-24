# Repo Map 架构

Repo Map 由扩展入口、服务层、扫描器、多个 indexer、generation storage 和 File Tools query adapter 组成。

## 模块边界

```text
agent/extensions/repo-map.ts
        ↓
src/repo-map/commands.ts / activation.ts
        ↓
src/repo-map/service.ts
        ├── repository / discovery
        ├── scanner + ignore snapshot
        ├── symbol / architecture / relationship / test indexers
        ├── lexical aliases
        └── storage generations
        ↓
src/repo-map/file-tool-query.ts
        ↓
file-tools find / grep / read / mutation
```

扩展只负责注册 `/init`、session-start 自动发现和 session activation entry。索引构建、缓存提交和查询不放在扩展入口中。

## 服务边界

`initializeRepoMap` 负责一次完整的构建或增量刷新：

1. 检测 repository identity。
2. 加载 Repo Map 和 File Tools 配置。
3. 创建 ignore snapshot。
4. 扫描文件并复用未变化记录。
5. 构建 symbol、架构、关系、测试和 alias 索引。
6. 生成 metadata、diagnostics 和 generation。
7. 原子提交 generation，并更新 current pointer。

查询只读取已经提交的 generation，不在模型工具调用期间执行完整扫描。

## 可选增强

Repo Map 本身提供结构索引，不要求 LSP 才能工作。File Tools 可以把 Repo Map 作为额外候选来源；LSP、Tree-sitter 或其他 parser 失败时，索引会保留可用的基础结果和 diagnostics。

查询层不得把结构候选伪装成实时正文命中：需要正文验证时，仍由 `grep` 或 `read` 读取当前文件。

## 延迟加载

扩展启动时只注册命令和轻量事件钩子。service、current pointer 和查询模块在首次需要时加载；并发加载共享同一个 Promise，加载失败后允许重试。

这保证未使用 Repo Map 的 session 不需要加载扫描器、indexer 或 parser。

## 单一事实来源

- ignore 匹配规则由 [File Tools ignore engine](../file-tools/ignore.md) 定义。
- 文件工具输出和错误协议由 [File Tools contracts](../file-tools/contracts.md) 定义。
- Repo Map 的图结构由 [graph-model.md](graph-model.md) 定义。
- generation 新鲜度由 [freshness.md](freshness.md) 定义。
