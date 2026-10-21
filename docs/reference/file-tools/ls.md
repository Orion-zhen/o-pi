# ls

列出目录直属成员，返回名称、类型和可见性标记。

## 参数

```json
{ "path": "src" }
```

path 可省略，默认当前工作区。相对路径按 cwd 解析，空字符串非法。

## 结果

```text
src 3
components/
index.ts
shared@ -> ../shared
```

| 形式 | 含义 |
| --- | --- |
| `name/` | 目录 |
| `name` | 普通文件 |
| `name@ -> target` | 符号链接 |
| `name?` | 其他对象 |
| ` !source` | 软忽略及来源 |

条目的 details 包含 name、path、type、link_target、ignored 和 ignore_source。普通点文件按规则正常显示。

目录中的符号链接保留链接身份。明确对链接调用 ls 时解析目标，仍检查受阻路径和进程权限。

## 排序与截断

类型顺序为目录、文件、符号链接、其他。同类先按小写名称，再按原始名称排序。

默认最多返回 200 项，超限保留排序前缀。details 包含 returned_entries、total_entries、truncated 和 continuation_hint。导航最多推荐三个可浏览的子目录，或建议使用 find 缩小范围。

```text
vendor 200/8432 truncated
a/
next: ls one of ["vendor/a"], or find path=["vendor"] with a narrower query/glob
```

## 错误

| 错误码 | 含义 |
| --- | --- |
| INVALID_PATH | 路径非法 |
| PATH_NOT_FOUND | 目录不存在 |
| NOT_A_DIRECTORY | 目标不是目录，可改用 read |
| PROTECTED_PATH | 受阻路径 |
| ACCESS_DENIED | 无权访问或技能未加载 |
| CONFIG_ERROR | 配置错误 |

取消会终止操作并释放租约。公共规则见[路径与安全](path-security.md)和[工具契约](contracts.md)。
