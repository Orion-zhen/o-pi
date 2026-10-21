# find

按名称或路径查找文件和目录，使用 fzf 扩展查询。

## 参数

```json
{
  "query": "auth !test .ts$",
  "path": ["src", "packages"],
  "glob": "**/*.{ts,tsx}"
}
```

query 必填，最长 512 字符。path 为非空目录数组，默认当前工作区，多个范围取并集。glob 相对每个范围匹配，不含 `/` 时递归匹配文件名。

## 查询语法

| 查询 | 含义 |
| --- | --- |
| `auth service` | 同时模糊匹配两个词 |
| `auth \| session` | 匹配任一词 |
| `'auth-service` | 精确子串 |
| `'auth'` | 单词或路径段边界 |
| `^src` | 前缀 |
| `.ts$` | 后缀 |
| `^src/auth.ts$` | 完整范围相对路径 |
| `!test` | 排除精确子串 |
| `!'tst` | 排除模糊子序列 |

反斜杠转义下一字符，`auth\ service` 表示含空格的词。每个词独立判断大小写，含大写字母时区分大小写，否则忽略。

## 范围与排序

发现服务应用 glob、受阻路径、软忽略和深度限制，按目录广度优先遍历。普通目录项直接使用目录快照，明确读取时重新验证路径。

对唯一候选的范围相对路径评分，输出使用规范展示路径。结果优先连续字符与路径段边界命中，同分采用稳定顺序。

排序器保留有界前缀。截断时先保留前 4 条，再覆盖未展示的正向 OR 分支，最后按相关性补齐。算法见[排序](ranking.md)。

## 输出

```text
src/auth/service.ts
src/AuthService.ts
packages/api/src/auth-handler.ts
```

目录以 `/` 结尾。截断时增加状态与导航：

```text
matched=90 selected=50; truncated=depth_limit,result_limit
incomplete: ["src/deep"]
next: narrow path to "src/auth" (12 candidates)
```

| truncated_by | 原因 |
| --- | --- |
| depth_limit | 达到搜索深度 |
| entry_limit | 达到共享遍历量 |
| result_limit | 达到结果数 |
| output_limit | 完整路径行超过词元预算 |

navigation 最多提供三个缩小范围建议和三个已知未完成范围。数量来自已扫描结果。修改 path 后，需要相应调整带锚点的 query 和 glob。

details.matches 保存结果选择，displayed_matches 保存实际展示项。stats 记录遍历和跳过数量。

## 部分失败与取消

至少一个范围成功时保留结果，失败范围写入 scope_errors 并在正文标记 partial。全部失败时返回错误。取消终止整次调用。

自动发现跳过软忽略项，明确指定的软忽略根可以搜索。候选不包含子符号链接，遍历不跟随它们。

常见错误为 INVALID_OPERATION、INVALID_PATH、PATH_NOT_FOUND、NOT_A_DIRECTORY、PROTECTED_PATH、ACCESS_DENIED、OPERATION_ABORTED 和 CONFIG_ERROR。
