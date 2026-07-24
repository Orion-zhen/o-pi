# 路径与安全

六个文件工具共享同一套路径解析和 blocked path 检查。普通使用摘要见 [文件工具设计](README.md)。

## 路径解析

路径先按当前 `cwd` 解析。工具只主动拒绝：

- 空路径；
- 空字节；
- 命中 `blocked_path`。

路径可以是相对路径、`..` 路径、绝对路径、包含 glob 字符的普通文件名，或指向 cwd 外的符号链接。工具不会展开 glob。

展示规则：

- workspace 内绝对路径折叠为 workspace-relative path；
- workspace 外绝对路径保持规范化后的绝对路径；
- workspace 外的相对路径仍由当前 `cwd` 解析；
- 内部逻辑路径统一使用 `/`。

## lexical path 与 realpath

`blocked_path` 检查分为两层：

1. **lexical path**：检查按 `cwd` 解析后的绝对路径、展示路径和 workspace-relative path。
2. **realpath**：检查已存在目标的真实路径。

`write` 还会检查最近已存在父目录的真实路径；覆盖已有文件时同时检查目标真实路径。这样可以避免通过 symlink 或 symlink parent 绕过保护路径。

symlink 本身允许存在和访问，但如果它指向 blocked path 就会被拒绝。工具不要求 realpath 位于 workspace 内。

## Ignore 与 blocked path

两者含义不同：

```text
soft ignore  → 自动发现时跳过，明确路径仍允许访问
blocked path → 访问本身被拒绝或跳过
```

`.piignore` 和 `.gitignore` 不是访问控制机制。普通 dotfile 会正常出现；`.git/` 默认位于 `blocked_path`，因此不能直接被 `ls`、`find`、`grep`、`read`、`write` 或 `edit` 访问。

更多匹配细节见 [Ignore engine](ignore.md)。

## 工具特定的 symlink 行为

- `ls` 列出父目录中的 symlink entry，不按目标类型改写。
- 直接 `ls` 一个 symlink 路径时先解析 realpath。
- `ls` 不递归，因此不会遍历 symlink cycle。
- `find` 和 `grep` 不返回文件或目录 symlink，也不进入目录 symlink。
- `read`、`write`、`edit` 可以访问明确给出的 symlink 路径，但仍接受 lexical/realpath 检查。
- 递归搜索不跟随文件或目录 symlink。

## 常见错误

模型可见错误使用紧凑标签，完整结构保留在 `details`：

```xml
<error tool="read" code="FILE_NOT_FOUND">
File does not exist.
</error>
```

常见错误包括：

- `PATH_NOT_FOUND`：`ls` 目标目录不存在。
- `FILE_NOT_FOUND`：`read` 目标文件不存在。
- `NOT_A_DIRECTORY`：`ls` 目标不是目录。
- `NOT_A_FILE`：`read` 目标不是普通文件。
- `PROTECTED_PATH`：命中 `blocked_path`。
- `CONFIG_ERROR`：配置无法读取、解析或通过 schema 校验。
- `ACCESS_DENIED`：运行时无权访问目标。

恢复方式：

- `NOT_A_DIRECTORY`：使用 `read` 读取明确文件，或 `ls` 父目录。
- `NOT_A_FILE`：使用 `ls` 浏览目录。
- 搜索结果缺失：检查 scope、ignore snapshot 的 `winner.sourcePath` 和 `winner.line`。
- `blocked_path`：不能通过改用 symlink 绕过，应选择允许的路径。
