# Repo Map 生命周期

Repo Map 有两个相互独立的生命周期：磁盘上的 generation 生命周期，以及当前 session 的 activation 生命周期。

## Session 启动

扩展在 `session_start` 注册轻量自动发现：

1. 检查当前工作目录是否存在可发现的 Repo Map。
2. 没有索引时保持未激活，不触发完整扫描。
3. 找到已有索引时检查是否需要 refresh。
4. 需要 refresh 时在后台执行，并写入新的 activation entry。
5. 失败时保留基础 File Tools 能力，不阻塞 session 启动。

自动激活可以被当前 session 的 `/init off` 禁用，直到用户再次初始化。

## Activation

activation 是 session branch 中的 custom entry，包含：

- repository root
- map ID
- generation ID
- activation time
- freshness 和可选 diagnostic

它不进入模型上下文，只用于在当前 session 中判断哪个 generation 可以被查询。

后续 activation 会覆盖同一 branch 上之前的 activation；deactivation 会移除当前激活状态。

## 命令状态

| 命令 | 状态变化 |
| --- | --- |
| `/init` | 构建或加载 generation，并激活它 |
| `/init status` | 只读当前 activation 和 generation 状态 |
| `/init refresh` | 复用已有文件和解析结果后刷新 |
| `/init rebuild` | 不读取旧 generation，完整重建 |
| `/init off` | 写入 deactivation，停止当前 session 自动激活 |

## 懒加载和重试

- session start 只做发现，不同步加载完整 service。
- current pointer 和 service 通过 retryable loader 加载。
- 并发请求共享加载中的 Promise。
- import 或初始化失败不会永久污染进程状态，后续调用可以重试。

## 查询 gate

查询前需要同时满足：

- session 存在 activation。
- activation 指向的 generation 仍是 current generation。
- generation root 和 map ID 匹配。
- 请求路径位于 repository root 内。
- freshness 不是 `stale` 或 `unavailable`。

gate 失败时返回结构化原因，调用方应退回基础文件工具，而不是继续使用旧图。

## Mutation 同步更新

`write`/`edit` 成功写盘后的 Repo Map 增强保持同步语义：

1. 从 activation 读取并验证 mutation 前 generation。
2. 判断变更路径是否已在 generation 中或仍属于扫描 scope。
3. 按 map ID 串行 refresh，并把已验证 before generation 作为可选 previous 传入。
4. service 再核对 root、map ID、activation generation 和磁盘 `CURRENT`；不匹配时回到正常读取边界。
5. refresh 扫描并原子提交 generation，成功后才追加 activation。
6. 直接使用 refresh 返回的内存 generation 计算 before/after impact，并对最终候选执行实时 content hash 校验。
7. Repo Map refresh 或 impact enhancement 失败时降级为 partial diagnostic，不回滚已成功的文件 mutation。

工具返回时同步 refresh 已结束；mutation 链路没有后台任务、debounce 或允许 stale query 的最终一致性窗口。并行启动且属于同一 assistant 消息的 mutation 可以共享一次 batch refresh，串行 mutation 仍分别刷新。

## 更新并发

同一个 map ID 的 refresh 按顺序执行。mutation 后的 refresh 不允许与另一个 refresh 并发提交，以避免较旧工作区快照覆盖较新的 generation。锁内仍检查 `CURRENT`、扫描结束时的 HEAD 和取消信号；generation 只有完整提交并原子切换 `CURRENT` 后才可见。

跨不同仓库的更新不共享这一串行锁。
