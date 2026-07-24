# `ls`

`ls` 只列出指定目录的直属成员。它无副作用、不递归、不读取文件内容、不搜索内容，也不返回 size、mtime、权限、owner 或 inode 等 metadata。

## 参数

```json
{
  "path": "src"
}
```

- `path` 可选，默认当前 workspace。
- `.` 表示当前 `cwd`。
- 相对路径按当前 `cwd` 解析。
- workspace 内绝对路径以 workspace-relative path 返回。
- workspace 外绝对路径保持规范化后的相对或绝对路径。
- 空字符串非法。

## 成功结果

模型可见结果使用紧凑 shell 风格文本，完整 entry 保留在 `details`：

```text
src 3
components/
index.ts
shared@ -> ../shared
```

entry 字段包括：

- `name`：当前目录下的 basename；
- `path`：规范化后的展示路径；
- `type`：`directory`、`file`、`symlink` 或 `other`；
- `link_target`：symlink 的原始 `readlink` 目标；
- `ignored`：命中 soft ignore 时为 `true`；
- `ignore_source`：可选的简短来源。

文本格式：

- `name/`：目录；
- `name`：普通文件；
- `name@ -> target`：符号链接；
- `name?`：其他文件系统对象；
- ` !source`：soft ignored 标记。

## Dotfile 与 symlink

`.gitignore`、`.github`、`.vscode`、`.env.example` 等普通 dotfile 会正常返回；dotfile 不等于 ignored。`.piignore` 和 `.gitignore` 自身也会正常出现。

父目录中的 symlink 作为 `type: "symlink"` 返回，不按目标类型改写。直接 `ls` symlink 路径时会先解析 realpath。指向 cwd 外的 symlink 可以访问，但仍受进程和操作系统权限限制。`ls` 不递归，因此不会遍历 symlink cycle。

父目录中的 symlink entry 按逻辑名称参与 ignore 匹配。blocked path 和 realpath 检查见 [路径与安全](path-security.md)。

## 排序与截断

排序不依赖文件系统返回顺序、mtime、size 或当前 locale：

1. `directory`；
2. `file`；
3. `symlink`；
4. `other`；
5. 同类型内按 `name.toLowerCase()`；
6. 大小写折叠相同时按原始 `name`。

默认最多返回 200 个可见直属成员。超出时返回前 200 个稳定排序条目，并设置 `truncated: true`，同时提供 `returned_entries`、`total_entries` 和 `continuation_hint`。不会自动递归、自动过滤或提供 cursor 分页。

```text
vendor 200/8432 truncated
a/
[narrow path]
```

## 错误

- 目标不存在：`PATH_NOT_FOUND`；
- 目标不是目录：`NOT_A_DIRECTORY`；
- 命中 blocked path：`PROTECTED_PATH`；
- 无权访问：`ACCESS_DENIED`。

遇到 `NOT_A_DIRECTORY` 时，应读取明确文件，或列出其父目录。公共错误格式见 [工具契约](contracts.md)。
