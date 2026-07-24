# LSP 内部增强

LSP 只作为 `grep` / `read` / `write` / `edit` 的可选内部后端，不注册模型可见 `lsp` 工具。

## 配置

主配置：

```text
agent/configs/lsp.jsonc
```

环境变量 `PI_LSP_CONFIG` 可覆盖路径。当前实现不读取项目级 `.pi/configs/lsp.jsonc`，因为配置会执行本地 language server command。

顶层字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。设为 `false` 后不启动任何 language server，文件工具保持普通行为。 |
| `exclude_paths` | `["~"]` | 精确匹配这些 workspace root 时不启动 LSP。支持 `~` 表示用户家目录；仓库配置排除 home 根目录，避免触发全盘扫描。配置文件缺失时内置回退值为 `[]`。 |
| `startup_timeout_ms` | `8000` | server `initialize` 请求超时，范围 `100`-`60000`。超时后该 server 视为 unavailable。 |
| `request_timeout_ms` | `5000` | 单次 LSP 请求超时，范围 `100`-`60000`。用于 `documentSymbol`、`workspace/symbol` 等请求。 |
| `idle_timeout_ms` | `300000` | server 空闲关闭时间，范围 `1000`-`3600000`。关闭后下次文件工具调用会按需重启。 |
| `max_restarts` | `2` | server 崩溃后的最多重启次数，范围 `0`-`10`。binary 缺失属于 unavailable，不做崩溃重启。 |
| `diagnostics` | 见下表 | 控制 `write` / `edit` 成功后的诊断等待和返回内容。 |
| `read` | 见下表 | 控制 `read` 的 outline / enclosing symbol 增强。 |
| `grep` | 见下表 | 控制 `grep` 的 workspace symbol 增强。 |
| `servers` | TypeScript / Python / Rust / YAML | language server 列表，最多 50 个。配置文件缺失时使用同一份内置列表。ID 和扩展名必须全局唯一。 |

`diagnostics`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否在 `write` / `edit` 写盘成功后等待当前文件 diagnostics。关闭后不返回 `lsp.diagnostics`。 |
| `max_wait_ms` | `3000` | 等待 `publishDiagnostics` 的最长时间，范围 `0`-`60000`。超时返回 `status: "timeout"`，不改变工具成功状态。 |
| `settle_ms` | `150` | 收到 diagnostics 后继续等待稳定的时间，范围 `0`-`5000`，避免 server 连续推送时取到中间态。 |
| `max_items` | `8` | 返回给模型和 expanded TUI 的诊断条数，范围 `0`-`100`。统计字段仍按过滤后的全部诊断计算。 |
| `min_severity` | `"warning"` | 最低返回级别。可选 `"error"`、`"warning"`、`"information"`、`"hint"`；级别越低返回越多。 |

`read`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `outline` | `true` | 内容被 `read` 截断时是否附加 `lsp.outline`。完整小文件不会触发 LSP outline。 |
| `max_symbols` | `40` | `lsp.outline` 最多返回 symbol 数，范围 `0`-`200`。partial range 的 `lsp.enclosing_symbol` 不受此开关影响。 |

`grep`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `workspace_symbols` | `true` | `grep` 在 `match=auto` 且 query 像 symbol 时是否调用 `workspace/symbol`。 |
| `references` | `false` | 是否在 workspace symbol 命中后继续调用 `textDocument/references`，把引用位置作为额外 `grep` 候选。默认关闭，避免慢 server 放大请求量。 |
| `max_symbols` | `20` | `workspace/symbol` 最多接收的 symbol 命中数，范围 `0`-`200`。命中仍会经过 path scope、ignore 和输出预算。 |
| `max_references` | `20` | `textDocument/references` 最多接收的引用命中数，范围 `0`-`200`。引用命中使用 `lsp symbol` reason。 |

`servers[]`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `id` | 必填 | server 稳定 ID。只能包含字母、数字、`_`、`-`，且所有 server 必须唯一。 |
| `enabled` | `true` | 单个 server 开关。关闭后不会匹配文件，也不会启动 transport；但仍参与 ID/扩展名冲突校验。 |
| `transport` | 必填 | 连接方式。`{"type":"stdio","command":"...","args":[]}` 启动本地 server；`{"type":"tcp","host":"127.0.0.1","port":2087}` 连接用户提供的 endpoint。TCP server 由用户负责提供，Pi 只负责连接和清理。 |
| `language_id` | 首个扩展名推断 | 发送 `textDocument/didOpen` 时使用的 language ID；建议显式配置。 |
| `extensions` | 必填 | 文件扩展名列表，必须带前导点，加载时统一转小写。任意两个 server（包括 disabled server）不能共享扩展名；冲突会使整个配置加载失败。 |
| `initialization_options` | 未设置 | 原样传给 LSP `initialize.initializationOptions`，用于 server 私有配置。 |

为保持旧配置可用，`command`/`args` 仍可直接写在 server 对象中，加载时会规范化为 `stdio transport`。

仓库配置包含 TypeScript、Python、Rust、YAML stdio server，并在注释中提供 TCP endpoint 示例。配置结构如下；两种 server 都由用户提供，Pi 不启动 TCP server：

```jsonc
{
  "servers": [
    {
      "id": "typescript",
      "transport": { "type": "stdio", "command": "typescript-language-server", "args": ["--stdio"] },
      "language_id": "typescript",
      "extensions": [".ts"]
    },
    {
      "id": "remote-example",
      "transport": { "type": "tcp", "host": "127.0.0.1", "port": 2087 },
      "language_id": "remote",
      "extensions": [".remote"]
    }
  ]
}
```

binary 不存在、TCP endpoint 不可达或 initialize 失败时 server 标记为 unavailable，文件工具继续成功执行。

## 行为

* `read`：部分行范围读取时可返回 `lsp.enclosing_symbol`；内容截断时可返回紧凑 `lsp.outline`。
* `grep`：仅在 `match=auto` 且 query 像 symbol 时调用 workspace/symbol；请求只发送给当前有效 scope 文件扩展名对应的 server。目录 scope 会按实际文件扩展名选择多个 server；空 scope 或无相关 server 时不创建 client。`grep.references` 开启后再查询引用位置；命中仍经过现有 ignore、path scope 和输出预算。
* `write`：写盘成功后发送 didOpen/didChange/didSave，等待当前文件 diagnostics；诊断错误不改变 `status: "written"`。
* `edit`：preview 不调用 LSP；成功写盘后对比编辑前后 diagnostics；诊断错误不改变 `status: "applied"`。
* `ls` / `find`：不接入 LSP。

不会自动 apply code actions、organize imports、跨文件 rename。

### 协议 session

initialize 返回的 capabilities 会保存在 session 中；不支持的 document symbols、workspace symbols 或 references 不会发送请求。session 提供带超时和协议级取消的 typed request/notification 入口，并统一接收 diagnostics、日志和 progress。文档生命周期包含 didOpen、didChange、didSave、didClose。

server 主动 request 默认返回 `MethodNotFound`，不会自动执行 `workspace/applyEdit` 等有副作用操作；只有显式注册安全 handler 后才会处理。

新增高级 feature 时，在 `src/lsp/features/index.ts` 增加 typed adapter：先用 `featureAvailable(session, definition)` 检查 capability，再通过 `session.request(RequestType, params, options)` 发送请求。将 adapter 加入 `lspFeatureAdapters` 后，manager、registry、transport 和 session 生命周期无需修改；不可用 capability 应返回 `undefined`，由 file-tools 继续普通降级。

## 命令

```text
/lsp
/lsp status
/lsp reload
/lsp diagnostics [path]
```

`/lsp` 等价 `/lsp status`。`reload` 会关闭所有 server 并清空 diagnostics ledger。`diagnostics` 显示 workspace 或指定文件的已知诊断。

## 故障排查

`/lsp status` 查看配置路径、server 状态、最后错误、打开文档数和最近 diagnostics 数。

常见 unavailable 原因：

* language server 未安装或不在 `PATH`；
* `command` / `args` 配置错误；
* TCP `host`/`port` 无效或 endpoint 未提供；
* initialize 超时或协议握手失败；
* server 启动后崩溃。

先运行 `/lsp status` 查看 `config_path`、server 状态和 `last_error`。配置 ID/扩展名冲突会在加载阶段拒绝整个 server 列表，修复配置后执行 `/lsp reload`。

这些情况不会让成功的文件读写搜索变成失败。
