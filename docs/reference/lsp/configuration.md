# LSP 配置

默认配置为 [`agent/defaults/lsp.jsonc`](../../../agent/defaults/lsp.jsonc)，用户配置为 `~/.pi/agent/configs/lsp.jsonc`，项目配置为 `.pi/configs/lsp.jsonc`。路径环境变量见[配置分层](../runtime/configuration.md)。

用户层设置 `servers` 时整体替换默认服务器集合。项目层按服务器 ID 合并，同一服务器的 `languages` 按语言 ID 合并，`init` 和 `settings` 对象递归合并，数组与标量整体替换。

项目服务器命令会在本机启动，只加载可信项目的配置。

## 全局字段

| 字段 | 默认值 | 范围或含义 |
| --- | --- | --- |
| `enabled` | true | 总开关 |
| `exclude_paths` | `["~"]` | 根目录与这些路径完全相同时关闭增强 |
| `startup_timeout_ms` | 8000 | 100–60000，初始化超时 |
| `request_timeout_ms` | 5000 | 100–60000，单次请求超时 |
| `idle_timeout_ms` | 300000 | 1000–3600000，空闲关闭时间 |
| `max_open_documents` | 128 | 1–1024，文档状态缓存上限 |
| `servers` | 见默认文件 | 最多 50 个服务器 |

`diagnostics`：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | true | 修改后诊断 |
| `max_wait_ms` | 3000 | 拉取或等待诊断的上限 |
| `settle_ms` | 150 | 发布式诊断的稳定等待时间 |
| `max_items` | 8 | 展示条数 |
| `max_related_locations` | 3 | 每条诊断附加位置上限 |
| `min_severity` | `warning` | 最低严重程度 |

`grep`：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `workspace_symbols` | true | 允许工作区符号查询 |
| `max_symbols` | 20 | 有效工作区符号上限 |
| `max_exact_leaf_symbols` | 2 | 完全匹配末级名称的同名候选上限 |

## 服务器

```json
{
  "servers": {
    "python": {
      "command": ["ty", "server"],
      "languages": { "python": "*.py" },
      "settings": { "ty": { "diagnosticMode": "workspace" } }
    }
  }
}
```

服务器 ID 以字母开头，后续为字母、数字、`_` 或 `-`。

| 字段 | 含义 |
| --- | --- |
| `enabled` | 单个服务器开关 |
| `fallback` | 与普通服务器同时匹配时作为后备 |
| `command` | 程序及参数数组，直接启动 |
| `tcp` | `{ "host": "127.0.0.1", "port": 2087 }`，与 command 二选一 |
| `languages` | LSP 语言 ID 到 glob 或 glob 数组 |
| `init` | `initializationOptions` |
| `settings` | 服务器运行配置 |

## 语言与选择器

选择器匹配工作区相对 POSIX 路径，区分大小写。不含 `/` 时匹配任意目录中的文件名，含 `/` 时匹配完整相对路径。支持 `*`、`?`、`[]`、`{a,b}` 和 `**`。

每个文件只选择一个服务器和语言 ID。普通服务器优先于 fallback，同级多匹配视为歧义，并在状态中报告。

语言 ID 使用服务器官方客户端声明的值。例如 `typescriptreact`、`dockerfile` 和 `dockercompose`。可从服务器文档、VS Code 扩展的 `contributes.languages`、`documentSelector` 或协议日志确认。

## settings

服务器 ID、语言 ID 和配置节是三个独立名称。上例的配置节为 `ty`。

`workspace/configuration` 请求 `ty` 时返回 `settings.ty`，请求 `ty.completions` 时返回对应嵌套对象，未指定节时返回整个 settings，缺失节返回 null。初始化后还发送完整的 `workspace/didChangeConfiguration`。

官方点号字段通常需要转换为嵌套对象，例如 `rust-analyzer.check.command` 对应 `settings["rust-analyzer"].check.command`。优先参考服务器文档或通用 LSP 客户端示例。

## 默认服务器

默认文件提供 TypeScript、HTML/Handlebars、JSON/JSONC、CSS/SCSS/Less、Python、Java、Rust、Go、C/C++、LaTeX、TOML、Docker 和 YAML 路由。

- TypeScript 使用 `tsc --lsp --stdio`，需要 PATH 中的 TypeScript 7。
- Java 使用 JDT LS，需要 Java 21 或更高版本启动。
- HTML、JSON、CSS 使用 `vscode-langservers-extracted` 的程序。
- TOML 使用 `tombi lsp`。
- YAML 作为通用回退，Docker 接管其 Compose 文件。

完整命令、语言选择器和服务器参数以默认文件为准。常用服务器配置资料：[ty](https://docs.astral.sh/ty/reference/editor-settings/)、[rust-analyzer](https://rust-analyzer.github.io/book/configuration)、[gopls](https://go.dev/gopls/settings)、[clangd](https://clangd.llvm.org/config)、[JDT LS](https://github.com/eclipse-jdtls/eclipse.jdt.ls)、[Tombi](https://tombi-toml.github.io/tombi/docs/configuration/)。
