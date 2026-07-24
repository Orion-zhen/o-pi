# 工具契约

本文说明六个文件工具共享的参数、模型输出、错误和提示词约定。各工具的字段细节见 [工具文档](README.md#深入阅读)。

## 输入约定

路径参数按工具语义分为单路径和多路径：

- `ls`、`read`、`write`、`edit` 接受一个明确路径。
- `find`、`grep` 的 `path` 是非空数组，多个 scope 表示 OR/union，不是 AND。
- 相对路径按当前 `cwd` 解析；空路径、空数组和空元素非法。
- `find` 和 `grep` 的旧单路径或分隔字符串由 `tool-repair` 迁移；无法可靠解析时交给 schema 校验失败，不猜测真实路径。

`find` 的 `query` 可以是路径、名称、路径片段、概念或 glob；`grep` 的 `query` 可以是文本、symbol、正则或代码意图。glob 只限制候选范围，不改变公共路径安全规则。

## 模型可见结果

工具成功结果优先使用紧凑文本，完整结构保留在 `details`。模型可见的自生成标签、属性、标点和分隔符使用紧凑 ASCII；文件名、源码、诊断、shell 输出和网页等原始 payload 保留 Unicode。

默认或内部字段，例如 `encoding: utf-8`、`bom: false`、版本、fingerprint 和完整 diff，通常只进入 `details`。只有会改变下一步操作的状态才进入模型文本，例如：

- `ignored`；
- `truncated` 或 continuation；
- 搜索扫描或结果限制；
- LSP diagnostics 摘要；
- `nearby` / `related` 非命中结果。

TUI 展示不受模型可见 ASCII 协议限制，可以使用图标和其他显示字符。

## 输出预算

`ls`、`read`、`find` 和 `grep` 都有数量或 token budget：

- `ls` 限制直属 entry 数；
- `read` 限制行数和字节数；
- `find` 限制扫描条目、具体结果和模型文本；
- `grep` 限制扫描文件、代码区域和模型文本。

预算不足时，输出必须保留状态首行，不能让尾部截断掩盖结果不完整。`read` 返回 continuation 行号；`find` 区分 `scanTruncated`、`resultLimited` 和 `outputTruncated`；`grep` 区分扫描跳过、候选上限和输出降级。

正文、片段和 signature 按预算降级，而不是随机截断。详细 token 估算见 [Token Counter](../token-counter.md)。

## 统一错误

错误使用短标签，完整结构保留在 `details`：

```xml
<error tool="read" code="FILE_NOT_FOUND">
File does not exist.
</error>
```

错误不会伪装成成功的零结果。无效正则、路径错误、权限错误、取消和索引基础设施错误都返回相应结构化错误；只有合法搜索但没有命中时才返回 success/none。

带有恢复方式的错误会增加 `next:` 提示。`READ_REQUIRED`、`STALE_READ` 和 `OLD_TEXT_*` 都要求重新读取文件，并基于最新内容生成新的 `edit` replacement。

## 版本与 mutation

`read` 可以在当前 session 记录原始字节版本。`edit` 写入前自动校验该版本，避免把外部修改覆盖掉。`write` 是独立的完整写入操作，不更新 `read` 版本缓存。

TUI 可以在展开态展示 `write` 或 `edit` 的精简 diff，但模型可见成功正文只确认写入事实，不包含完整 diff、版本字段或内部 fingerprint。

## Prompt 设计

工具 schema 字段描述承载参数约束和低频协议；系统提示词只保留高频决策规则：

- 知道目录时用 `ls`；
- 知道路径模式时用 `find`；
- 搜索正文或 symbol 时用 `grep`；
- 读取明确文件用 `read`；
- 新建或完整覆盖用 `write`；
- 局部修改遵循 `read → edit`。

重复的实现细节不进入长期 prompt。提示词字段的 Pi 适配见 [Pi 工具提示词字段](../tool-prompt-fields.md)。
