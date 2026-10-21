# 配置分层

## Pi 原生配置

Pi 管理 `settings.json`、`models.json`、`keybindings.json`、认证、主题和会话。默认目录是 `~/.pi/agent/`，通过 `PI_CODING_AGENT_DIR` 可改变该目录。

编辑器 schema 位于 `https://pi.dev/schemas/`，对应 `settings.schema.json`、`models.schema.json`、`keybindings.schema.json` 和 `theme.schema.json`。

[settings 示例](../../../agent/settings.example.jsonc)包含常用体验配置。模型扩展字段见[模型配置](../models/configuration.md)。

## 模块配置位置

模块 JSONC 按以下顺序合并：

```text
安装资源目录/agent/defaults/<name>.jsonc
~/.pi/agent/configs/<name>.jsonc
项目/.pi/configs/<name>.jsonc
```

默认层随应用发布。用户层和项目层填写覆盖字段，文件可以省略。打包程序的默认层来自提取或随包分发的资源目录。

| 模块 | 用户路径环境变量 | 项目路径环境变量 | 项目根目录环境变量 |
| --- | --- | --- | --- |
| approval-gate | `PI_APPROVAL_GATE_CONFIG` | — | — |
| auto-title | `PI_AUTO_TITLE_CONFIG` | — | — |
| bash-tool | `PI_BASH_TOOL_CONFIG` | — | — |
| discord-presence | `PI_DISCORD_PRESENCE_CONFIG` | `PI_DISCORD_PRESENCE_PROJECT_CONFIG` | `PI_DISCORD_PRESENCE_PROJECT_ROOT` |
| file-tools | `PI_FILE_TOOLS_CONFIG` | `PI_FILE_TOOLS_PROJECT_CONFIG` | `PI_FILE_TOOLS_PROJECT_ROOT` |
| lsp | `PI_LSP_CONFIG` | `PI_LSP_PROJECT_CONFIG` | `PI_LSP_PROJECT_ROOT` |
| subagent | `PI_SUBAGENT_USER_CONFIG` | `PI_SUBAGENT_PROJECT_CONFIG` | `PI_SUBAGENT_PROJECT_ROOT` |
| gui | `PI_GUI_CONFIG` | — | — |
| tui | `PI_TUI_CONFIG` | — | — |
| web-tools | `PI_WEB_TOOLS_CONFIG` | — | — |

GUI 的用户配置目录跟随 `PI_CODING_AGENT_DIR`。表中其他模块的用户路径由各自环境变量覆盖，否则使用 `~/.pi/agent/configs/`。

项目配置依次使用：指定的项目配置文件、指定根目录下的 `.pi/configs/`、从工作目录向上找到的最近 `.pi/configs/`。查找以最近的 `.pi` 目录为准，与 Git 边界无关。

## 合并与校验

普通对象递归合并，数组和标量由高层整体替换。默认文件包含完整固定字段，用户和项目文件接受部分字段。

特殊规则：

| 模块 | 规则 |
| --- | --- |
| Discord Presence | `profiles.<name>.details` 整体替换 |
| 文件工具 | 项目层只追加 `blocked_path`、`ignored_path`，可以覆盖限制和 `ignore.builtin_profile` |
| LSP | 用户 `servers` 整体替换默认集合，项目 `servers` 按 ID 合并，`languages` 按语言 ID 合并 |
| 子代理 | 项目层只接受并发、超时、重试和输出预算等运行参数 |

加载器接受 UTF-8 BOM。非法 JSONC、未知字段、错误类型和语义错误会使配置加载失败。模块决定如何呈现错误，例如文件工具返回 `CONFIG_ERROR`。

读取前后比较文件指纹，最多读取三次以取得稳定快照。文件工具和网页工具共用配置缓存，合并并发加载，每次返回独立副本。

GUI 编辑器从同一份文件原文生成表单与错误信息。保存时校验字段、检查原文版本，再原子替换文件。生效时机见各模块文档。

## 工具选择

默认工具使用 Pi 的 `settings.json.defaultTools`：

- 未配置：采用注册时的默认启用状态。
- 工具名列表：替换默认集合。
- 仅含 `+name` / `-name`：在默认集合上增减。
- 全局空列表：禁用全部工具。
- 项目空列表：继承全局选择。

CLI `--tools` 优先于 settings。恢复会话时，增减形式作用于历史工具集合，显式列表替换历史选择。

TUI 的 `/tools` 用 Enter 或空格切换，Ctrl+S 保存全局默认值。GUI 提供对应工具面板。`tool_search` 由候选状态自动管理，保存默认值时排除。

SDK 在下次模型请求时记录当前分支的工具声明，恢复与导航采用该记录。切换模型保留工具选择。

`codemode` 默认关闭。非 Windows 平台的内置 `powershell` 显示为不可用，Windows 可显式启用。powershell 沿用 SDK 执行，不经过本仓库的 Bash 审批解析和输出管理。子代理工具取决于可用代理定义。Codemode 下脚本工具的可调用范围见 [Codemode](../codemode/README.md)。

## 配置来源

实现位于 `src/harness/config-loader.ts`、`src/harness/config-values.ts` 和 `src/harness/config-cache.ts`。GUI 文件编辑位于 `src/gui/host/config/`。字段约束见 [`agent/schemas/`](../../../agent/schemas/)，默认值见 [`agent/defaults/`](../../../agent/defaults/)。
