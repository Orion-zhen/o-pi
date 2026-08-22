# `ls`

`ls` 只列出指定目录的直属成员。命令只组合文件系统的路径、元数据和可见性能力。它没有副作用，不会递归，也不会读取或搜索文件内容。结果不包含大小、修改时间、权限、所有者或 inode 等元数据。

## 参数

```json
{
  "path": "src"
}
```

- `path` 可选，默认为当前工作区。
- `.` 表示当前 `cwd`。
- 相对路径按当前 `cwd` 解析。
- 工作区内的绝对路径以工作区相对路径返回。
- 工作区外的绝对路径保持规范化后的相对或绝对形式。
- 空字符串非法。

## 成功结果

模型可见结果使用紧凑的 Shell 风格文本，完整条目结构保留在 `details` 中：

```text
src 3
components/
index.ts
shared@ -> ../shared
```

条目字段包括：

- `name`：当前目录中的基础名称。
- `path`：规范化后的展示路径。
- `type`：`directory`、`file`、`symlink` 或 `other`。
- `link_target`：符号链接的原始 `readlink` 目标。
- `ignored`：命中软忽略规则时为 `true`。
- `ignore_source`：可选的简短规则来源。

文本格式：

- `name/`：目录。
- `name`：普通文件。
- `name@ -> target`：符号链接。
- `name?`：其他文件系统对象。
- ` !source`：软忽略标记。

## 点文件与符号链接

`.gitignore`、`.github`、`.vscode` 和 `.env.example` 等普通点文件会正常返回。点文件不等于软忽略文件。`.piignore` 和 `.gitignore` 本身也会正常出现。

父目录中的符号链接以 `type: "symlink"` 返回，不按目标类型改写。直接对符号链接路径调用 `ls` 时，系统会先解析真实路径。指向 `cwd` 外的符号链接可以访问，但仍受 Pi 进程权限和操作系统权限限制。`ls` 不递归，因此不会遍历符号链接环。

父目录中的符号链接条目按逻辑名称参与忽略规则匹配。受阻路径和真实路径检查见[路径与安全](path-security.md)。

## 排序与截断

排序不依赖文件系统返回顺序、修改时间、大小或当前区域设置：

1. `directory`。
2. `file`。
3. `symlink`。
4. `other`。
5. 同类型内按 `name.toLowerCase()` 排序。
6. 大小写折叠后相同时，按原始 `name` 排序。

默认最多返回 200 个直属成员。条目超过限制时，结果返回稳定排序后的前 200 个条目，并设置 `truncated: true`。`details` 同时提供 `returned_entries`、`total_entries` 和 `continuation_hint`。工具不会自动递归、自动过滤或提供游标分页。

```text
vendor 200/8432 truncated
a/
[narrow path]
```

## 错误

- 目标不存在：`PATH_NOT_FOUND`。
- 目标不是目录：`NOT_A_DIRECTORY`。
- 命中受阻路径：`PROTECTED_PATH`。
- 无权访问：`ACCESS_DENIED`。

遇到 `NOT_A_DIRECTORY` 时，应使用 `read` 读取明确文件，或使用 `ls` 列出文件所在的目录。取消调用会终止命名空间、可见性或枚举操作，并释放租约。取消不会返回部分成功结果。

## 失败结果与模型输出

失败总是返回紧凑的 XML。路径、匹配规则和配置字段保留在 `details` 中，不进入模型正文：

```xml
<error>
Directory does not exist.
</error>
```

常见失败及正文：

| 错误码 | 模型正文 |
| --- | --- |
| `INVALID_PATH` | `Path must not be empty.`、`Path must not contain NUL bytes.` 或 `skill:// is a read-only locator supported only by read.` |
| `PATH_NOT_FOUND` | `Directory does not exist.` |
| `NOT_A_DIRECTORY` | `Path is not a directory.` |
| `PROTECTED_PATH` | `Path is blocked by file-tools config.` |
| `ACCESS_DENIED` | `Path cannot be accessed.` 或 `Directory cannot be listed.` |
| `CONFIG_ERROR` | 配置错误消息 |

只有错误提供恢复建议时，正文才包含 `next:`。公共错误格式见[工具契约](contracts.md)。
