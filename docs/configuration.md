# 配置分层

本文说明 `approval-gate`、`bash-tool`、`discord-presence`、`file-tools`、`lsp`、`subagent`、`tui` 和 `web-tools` 共用的 JSONC 配置分层机制。

## 配置层级

加载优先级从低到高为：

```text
<o-pi>/agent/defaults/<name>.jsonc
~/.pi/agent/configs/<name>.jsonc
<project>/.pi/configs/<name>.jsonc
```

各层用途如下：

1. 默认层随 o-pi 发布并由 Git 跟踪。默认文件必须存在，并通过完整配置校验。
2. 用户层用于当前用户的全局覆盖，可以不存在。
3. 项目层用于当前项目的覆盖，只对支持项目配置的模块生效，也可以不存在。

用户层和项目层只需包含需要覆盖的字段。默认层是固定配置字段的主要默认值来源。完整配置校验要求默认文件包含 JSON Schema 中的固定字段，但模块可以明确指定由运行时补齐的可选字段。当前例外是 `web-tools` 的 `network.proxy`。

加载器会解析所有层，并根据模块规则在合并前或合并后执行 JSON Schema 与语义校验。非法 JSONC、未知字段、错误类型或无效语义都会导致配置被拒绝，不会静默跳过错误层或回退到较低层。各模块向调用方呈现配置错误的方式可能不同。例如，文件工具返回 `CONFIG_ERROR`。

为避免读取到并发写入产生的混合内容，加载器会在读取前后比较所有配置文件的指纹。文件发生变化时，加载器最多重新读取两次。三次读取都无法获得稳定快照时，配置加载失败。

## 合并规则

默认情况下，普通对象递归合并。标量和数组由较高层整体替换。例如，用户层只覆盖对象中的一个字段时，同一对象的其他默认字段会保留。用户层提供数组时，默认数组会被完整替换。

以下模块使用专用规则：

- `discord-presence`：某一层配置 `profiles.<name>.details` 时，`details` 整体替换，不与低层字段递归合并。
- `file-tools`：项目层的 `blocked_path` 和 `ignored_path` 只能在用户配置基础上追加，重复项会被删除。项目层不得修改 `ignore.piignore`、`ignore.gitignore` 或 `ignore.git_tracked_files_bypass`。
- `lsp`：用户层配置 `servers` 时，整个默认 `servers` 对象被替换。项目层的 `servers` 按服务器 ID 合并。同一服务器的 `languages` 按语言 ID 合并，`init` 和 `settings` 中的对象递归合并，数组和标量整体替换。
- `subagent`：项目层使用独立的项目 JSON Schema，只能覆盖并发、超时、重试和输出预算等普通运行参数。

## 配置范围

支持项目层的模块如下：

| 模块 | 用户配置路径环境变量 | 项目配置路径环境变量 | 项目根目录环境变量 |
| --- | --- | --- | --- |
| `discord-presence` | `PI_DISCORD_PRESENCE_CONFIG` | `PI_DISCORD_PRESENCE_PROJECT_CONFIG` | `PI_DISCORD_PRESENCE_PROJECT_ROOT` |
| `file-tools` | `PI_FILE_TOOLS_CONFIG` | `PI_FILE_TOOLS_PROJECT_CONFIG` | `PI_FILE_TOOLS_PROJECT_ROOT` |
| `lsp` | `PI_LSP_CONFIG` | `PI_LSP_PROJECT_CONFIG` | `PI_LSP_PROJECT_ROOT` |
| `subagent` | `PI_SUBAGENT_USER_CONFIG` | `PI_SUBAGENT_PROJECT_CONFIG` | `PI_SUBAGENT_PROJECT_ROOT` |

`approval-gate`、`bash-tool`、`tui` 和 `web-tools` 只读取默认层和用户层。它们对应的用户配置路径环境变量分别为：

- `PI_APPROVAL_GATE_CONFIG`
- `PI_BASH_TOOL_CONFIG`
- `PI_TUI_CONFIG`
- `PI_WEB_TOOLS_CONFIG`

用户配置路径环境变量只重定向用户层，不替换默认层。默认层始终来自当前 o-pi 安装目录。

对于支持项目层的模块，项目配置路径按以下顺序确定：

1. 如果设置了对应的 `PI_*_PROJECT_CONFIG`，直接使用该文件路径。
2. 否则，如果设置了对应的 `PI_*_PROJECT_ROOT`，读取该目录下的 `.pi/configs/<name>.jsonc`。
3. 否则，从当前工作目录向上查找最近的 `.pi` 目录，并读取其 `configs/<name>.jsonc`。
4. 如果没有找到 `.pi` 目录，则不加载项目层。

项目根目录由最近的 `.pi` 目录确定，不依赖 Git 仓库边界。

## 独立的工具默认配置

工具启用状态使用独立的配置机制，不属于上述八个模块的默认层体系。相关文件为：

```text
~/.pi/agent/tools.jsonc
<project>/.pi/tools.jsonc
```

用户层和项目层按顺序叠加，但没有 `agent/defaults/tools.jsonc`。对应的环境变量是 `PI_TOOLS_CONFIG`、`PI_TOOLS_PROJECT_CONFIG` 和 `PI_TOOLS_PROJECT_ROOT`。项目根目录的查找方式与上述项目层相同。

## Git 和升级

仓库跟踪 `agent/defaults/` 和 `agent/schemas/`，但忽略 `agent/configs/`。因此，用户全局覆盖配置不会产生新的 o-pi Git 变更。项目中的 `.pi/configs/` 和 `.pi/tools.jsonc` 是否纳入版本控制由项目自行决定。

如果从旧目录布局升级，并且修改过 Git 已跟踪的 `agent/configs/*.jsonc`，请在拉取更新前备份这些文件。升级后，只把需要保留的差异写入新的用户覆盖配置。不要复制整份默认配置，否则新增默认字段后难以区分用户覆盖与项目默认值。
