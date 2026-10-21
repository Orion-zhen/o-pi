# grep

逐行搜索正文，将命中归入文本行或代码区域，并按相关性返回。

## 参数

```json
{
  "query": "Auth(Service|Client)",
  "mode": "regex",
  "path": ["src", "tests"],
  "glob": "**/*.{ts,tsx}"
}
```

query 区分大小写，逐逻辑行执行。mode 为 regex 或 literal，默认 regex。path 接受文件或目录数组，默认当前工作区，多个范围取并集。glob 相对每个范围匹配，不含 `/` 时匹配文件名。

无效正则立即返回 INVALID_REGEX。包含 CR、LF 或 NUL 的查询非法。literal 按原文匹配元字符。

## 搜索与结构

执行顺序：

```text
查询计划 -> 范围文件清单 -> 稳定正文扫描与 LSP 预热
-> 符号和语法结构 -> 关系证据 -> 排序 -> 选择与输出
```

小型代码文件一次读取，供 LSP、语法与缓存复用。普通文本和大文件逐行流式扫描。包含正则元字符的查询在 worker 中执行，取消时终止 worker。

正文命中聚合到最小可靠代码单元。有效 LSP 范围优先，Tree-sitter 补充声明、函数体、嵌套与匿名回调。结构不可用时返回文本行。

文档符号、引用、调用层次和定义分别判断能力。某文件或请求失败时保留其他成功结果。正文零命中时，工作区符号和受限词法锚点可以生成标记为 related 的结果。

## 排序

候选依次比较查询层级、权威等级、BM25F 字段分数、来源分数、覆盖率、区域大小与稳定路径顺序。

同一查询层级内，已确认的外部调用优先于外部引用，再到定义与未知。关系需要通过快照校验且目标明确，目录名称不会直接提高权威等级。

先限制相关区域数量，再应用总结果上限。前 4 条保持相关性顺序，其余使用同层级 MMR 减少重复。完整算法见[排序](ranking.md)。

## 输出

```text
<grep>
src/auth/service.ts:41-88 AuthService.login
  async login(credentials: Credentials): Promise<Session>
  42: async login(credentials: Credentials): Promise<Session> {
  caller: src/http/login.ts:27:5

src/session/cache.ts:12-46 SessionCache.restore [not match, related]
  29: const cachedSession = await this.storage.load(key);
</grep>
```

代码区域显示路径、范围、符号或具名归属、声明与代表行。匿名回调用 in 标记外层归属。声明和代表行最多 240 个 Unicode 码点，完整内容通过 read 获取。

每区域展示行数由 `grep_regional_display_limit` 控制，完整唯一命中保存在 match_lines。前 4 个区域各可附加最多 2 个 caller、callee 或 reference 位置，多目标使用 `?`。

同文件连续文本行共享路径标题，但仍分别参与排序。内部状态、评分和来源保存在 details。

## 截断与导航

| truncated_by | 原因 |
| --- | --- |
| depth_limit | 达到范围深度 |
| entry_limit | 达到共享文件遍历量 |
| byte_limit | 达到累计正文快照字节数 |
| result_limit | 达到输出区域数 |

```text
<grep truncated="result_limit">
...
+12 lower-ranked omitted
next: narrow path to "src/auth" (12 candidates)
</grep>
```

navigation 最多列出三个缩小范围建议和三个已知未完成范围。数量来自本次候选，不代表未扫描内容。

相关结果配额、正文命中和 AST 内部容量记录到 stats，不作为上述模型截断原因。模型输出按区域数限制，approx_tokens 仅用于观测。

## 文件、缓存与取消

文件清单记录身份、版本和大小，扫描与增强使用同一稳定快照。文件变化后丢弃该文件的部分结果。LF、CRLF、CR 和 UTF-8 BOM 按统一逻辑行处理，结构位置使用去除 BOM 后的 UTF-8 字节坐标。

累计字节预算按清单顺序预留，下个文件无法完整容纳时停止。并发数为可用 CPU 的一半，限制在 1–8。正文命中与相关锚点各最多 10000 条，单文件相关锚点最多 64 条。

`grep_ast_max_file_bytes` 限制结构增强和单文件缓存资格，`grep_content_cache_bytes`、`grep_content_cache_entries` 限制正文缓存，任一为 0 时关闭正文缓存。语法缓存绑定正文哈希，关系证据由当次查询生成。

取消作用于整次调用并释放资源。递归发现遵循[可见性](ignore.md)和[路径策略](path-security.md)。

## 零结果与错误

合法查询无候选时返回 none 和搜索统计。常见失败为 INVALID_OPERATION、INVALID_REGEX、INVALID_PATH、PATH_NOT_FOUND、PROTECTED_PATH、BINARY_FILE_UNSUPPORTED、ENCODING_UNSUPPORTED 和 OPERATION_ABORTED。
