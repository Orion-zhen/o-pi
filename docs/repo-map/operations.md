# Repo Map 操作与恢复

## 命令

```text
/init
/init status
/init refresh
/init rebuild
/init off
```

### `/init`

在当前仓库初始化或加载 Repo Map。成功后 generation 会写入当前 session activation。

### `/init status`

只读取当前 session activation、repository root、map ID、generation 和 freshness，不主动重建索引。

### `/init refresh`

扫描当前工作树，尽量复用未变化文件和已有解析结果。适用于代码修改、ignore 变化或普通 stale 状态。

### `/init rebuild`

不复用旧 generation，从当前仓库完整建立索引。适用于 generation 损坏、parser/schema 变化或 refresh 无法恢复时。

### `/init off`

写入当前 session 的 deactivation entry。它只影响当前 session，不删除磁盘上的 Repo Map。

## 常见状态和处理

| 状态或错误 | 处理 |
| --- | --- |
| 未初始化 | 执行 `/init` |
| `stale` | 执行 `/init refresh` |
| `unavailable` | 执行 `/init rebuild` |
| 扫描期间仓库变化 | 等待稳定后重新 `/init refresh` |
| 配置错误 | 修复 JSONC/schema 后重新初始化 |
| 文件过大或不支持 | 查看 diagnostics，使用 `read` 或 `grep` 直接检查 |
| Repo Map 失败 | 继续使用基础 File Tools |

## Session 行为

activation 写入 session custom entry，不进入模型上下文。session branch 上较新的 activation 会覆盖旧 activation；`/init off` 会阻止后续自动激活，直到再次执行 `/init`。

## 安全边界

命令只管理索引和 activation，不改变文件内容、不放宽 blocked path，也不绕过 File Tools 的 ignore 和 path guard。
