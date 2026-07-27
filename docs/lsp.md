# LSP 内部增强

LSP 只作为 `grep` / `read` / `write` / `edit` 的可选内部后端，不注册模型可见 `lsp` 工具。

## 配置

默认配置和用户全局覆盖分别位于：

```text
agent/defaults/lsp.jsonc
agent/configs/lsp.jsonc
```

环境变量 `PI_LSP_CONFIG` 可覆盖用户全局配置路径，但不替换默认层。若 workspace root 或其祖先存在项目配置：

```text
<project>/.pi/configs/lsp.jsonc
```

项目配置优先于全局配置，未设置的字段从全局配置继承；对象递归合并，数组和标量由项目配置整体替换。`servers` 按 server ID 合并，项目配置可覆盖或新增 server。也可用 `PI_LSP_PROJECT_CONFIG` 指定项目配置路径，或用 `PI_LSP_PROJECT_ROOT` 指定项目根目录。

项目配置会执行其中的本地 language server command，因此只应使用可信项目中的配置。

顶层字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。设为 `false` 后不启动任何 language server，文件工具保持普通行为。 |
| `exclude_paths` | 见默认文件 | 精确匹配这些 workspace root 时不启动 LSP。支持 `~` 表示用户家目录。 |
| `startup_timeout_ms` | `8000` | server `initialize` 请求超时，范围 `100`-`60000`。超时后该 server 视为 unavailable。 |
| `request_timeout_ms` | `5000` | 单次 LSP 请求超时，范围 `100`-`60000`。用于 `documentSymbol`、`workspace/symbol` 等请求。 |
| `idle_timeout_ms` | `300000` | server 空闲关闭时间，范围 `1000`-`3600000`。关闭后下次文件工具调用会按需重启。 |
| `max_restarts` | `2` | server 崩溃后的最多重启次数，范围 `0`-`10`。binary 缺失属于 unavailable，不做崩溃重启。 |
| `max_open_documents` | 见默认文件 | 每个 server session 最多保留的文档状态数，范围 `1`-`1024`。LRU 淘汰会先发送所需的 `didClose`，并清理全文和 symbol cache。 |
| `diagnostics` | 见下表 | 控制 `write` / `edit` 成功后的诊断等待和返回内容。 |
| `read` | 见下表 | 控制 `read` 的 outline / enclosing symbol 增强。 |
| `grep` | 见下表 | 控制 `grep` 的 workspace symbol 增强。 |
| `servers` | 见默认文件 | 以 server ID 为 key 的 language server 对象，最多 50 个。 |

`diagnostics`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否在 `write` / `edit` 写盘成功后查询当前文件 diagnostics。关闭后不返回 `lsp.diagnostics`。 |
| `max_wait_ms` | `3000` | pull diagnostics 请求或 fallback publish 等待的最长时间，范围 `0`-`60000`。没有本次结果时即使存在旧快照也返回 `status: "timeout"`。 |
| `settle_ms` | `150` | fallback 收到 publish 后事件驱动等待稳定的时间，范围 `0`-`5000`；每次新 publish 重置 debounce。pull report 不需要 settle。 |
| `max_items` | `8` | 返回给模型和 expanded TUI 的诊断条数，范围 `0`-`100`。统计字段仍按过滤后的全部诊断计算。 |
| `max_related_locations` | `2` | 每条诊断最多附加的 related locations 数，范围 `0`-`10`；位置写入现有 message，不增加工具协议字段。 |
| `min_severity` | `"warning"` | 最低返回级别。可选 `"error"`、`"warning"`、`"information"`、`"hint"`；级别越低返回越多。 |

`read`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `outline` | `true` | 内容被 `read` 截断时是否附加 `lsp.outline`。完整小文件不会触发 LSP outline。 |
| `max_symbols` | `40` | `lsp.outline` 整棵树最多返回的 symbol 数，范围 `0`-`200`。根和所有后代按 server 原始顺序执行稳定 DFS 并共享预算；partial range 的 `lsp.enclosing_symbol` 不受此开关影响。 |

`grep`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `workspace_symbols` | `true` | `grep` 在 `match=auto` 且 query 像 symbol 时是否调用 `workspace/symbol`。 |
| `references` | `false` | 是否在 workspace symbol 命中后继续调用 `textDocument/references`，把引用位置作为额外 `grep` 候选。默认关闭，避免慢 server 放大请求量。 |
| `max_symbols` | `20` | scope/URI 校验和去重后最多接收的有效 workspace symbol 数，范围 `0`-`200`。scope 外及 resolve 失败项不消耗预算。 |
| `max_references` | `20` | scope 校验和全局去重后最多接收的有效引用数，范围 `0`-`200`。引用只针对最终接收的 symbol，并使用 `lsp reference` reason。 |

`servers` 的 key 就是稳定 server ID，必须以字母开头且只能包含字母、数字、`_`、`-`。每个 server 支持：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 单个 server 开关。关闭后不参与文件路由，也不启动连接。 |
| `fallback` | `false` | 与普通 server 同时匹配时让普通 server 接管；适合 YAML 等通用后备 server。 |
| `command` | 与 `tcp` 二选一 | stdio server 的完整 argv；第一个元素是 executable，其余元素是参数，不经过 shell。 |
| `tcp` | 与 `command` 二选一 | `{"host":"127.0.0.1","port":2087}` 连接用户提供的 endpoint；Pi 不启动 TCP server。 |
| `languages` | 必填 | LSP language ID 到一个 selector 字符串或多个 selector 数组的映射。 |
| `init` | 未设置 | server 自己定义的初始化 JSON，原样传给 LSP `initialize.initializationOptions`；字段名和嵌套结构不由 Pi 定义。 |
| `settings` | 未设置 | server 自己定义的运行时配置树，供 `workspace/configuration` 按 section 返回，并在初始化后通过 `workspace/didChangeConfiguration` 整体发送；不会自动从 Go 项目配置或环境变量补充。 |

配置不包含 `id`、`transport.type`、`args`、`extensions`、`language_id` 或 `language_ids` 等重复字段，也不从扩展名隐藏推断 language ID。合并后的全局与项目配置使用同一 schema；项目 server 可以只提供需要覆盖的字段。用户可以覆盖默认 server 集合；项目配置再按 server ID 合并。示例配置可包含 TypeScript、Python、Rust、Clangd（C/C++）、Docker 和 YAML stdio server，并在注释中提供 TCP endpoint 示例：

```jsonc
{
  "servers": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "languages": {
        "typescript": "*.ts",
        "typescriptreact": "*.tsx",
        "javascript": "*.{js,mjs,cjs}",
        "javascriptreact": "*.jsx"
      }
    },
    "yaml": {
      "fallback": true,
      "command": ["yaml-language-server", "--stdio"],
      "languages": { "yaml": "*.{yaml,yml}" }
    },
    "remote-example": {
      "tcp": { "host": "127.0.0.1", "port": 2087 },
      "languages": { "remote": "*.remote" }
    }
  }
}
```

### `settings`、section 与嵌套字段

`settings` 没有跨 language server 的统一 schema。它的顶层 key 通常是 server 请求的 configuration section，但 section 名由 server 实现决定，不是 Pi 的 server ID 或 `languages` 中的 language ID。三类名称即使拼写相同也要分别理解：

```jsonc
{
  "servers": {
    "typescript": {                 // Pi server ID
      "command": ["typescript-language-server", "--stdio"],
      "languages": {
        "typescript": "*.ts"       // textDocument/didOpen 的 language ID
      },
      "init": {
        "preferences": {            // initialize.initializationOptions 的 server 专有字段
          "quotePreference": "double"
        }
      },
      "settings": {
        "formattingOptions": {      // workspace/configuration section
          "tabSize": 2,
          "insertSpaces": true
        },
        "typescript": {             // didChangeConfiguration 中的 server 专有 namespace
          "format": { "semicolons": "insert" }
        }
      }
    }
  }
}
```

Pi 对 `workspace/configuration` 的查找规则是：

- server 请求 `section: "typescript"` 时返回 `settings.typescript`；
- 请求 `section: "typescript.format"` 时返回 `settings.typescript.format`；
- section 缺失时返回 `null`；没有 section 时返回整个 `settings`；
- `scopeUri` 只用于确认请求仍在当前 workspace 内，当前不提供按文件或目录覆盖的 settings。

初始化完成后，Pi 还会把整个 `settings` 作为 `workspace/didChangeConfiguration.params.settings` 发送。因此配置必须同时符合目标 server 对该 notification 和 configuration request 的约定。

嵌套对象也完全由 server 定义。特别是 `typescript-language-server` 的 `preferences` 是 `init.preferences`，会作为 tsserver `UserPreferences` 在 initialize 时传入；它不是 `settings.typescript.preferences`。该 server 的运行时格式化配置则使用 `settings.typescript.format` / `settings.javascript.format`，并可能单独请求 `formattingOptions` section。不要只因其他编辑器使用了名为 `preferences` 的 UI 设置就移动其层级。

官方配置文档中的点号字段通常表示 JSON 路径，而不是包含点号的字面 key。例如：

| 官方字段 | `lsp.jsonc` 中的嵌套路径 |
| --- | --- |
| `ty.diagnosticMode` | `settings.ty.diagnosticMode` |
| `rust-analyzer.check.command` | `settings["rust-analyzer"].check.command` |
| `yaml.format.enable` | `settings.yaml.format.enable` |
| `[language].format.semicolons` | `settings.typescript.format.semicolons` 或 `settings.javascript.format.semicolons` |

确认 section、字段名、类型和允许值时按以下顺序查找：

1. 以目标 server 当前版本的官方配置文档为准，搜索 `workspace/configuration`、`workspace/didChangeConfiguration`、`settings`、`configuration section` 和 `initializationOptions`。`init` 与 `settings` 经常是两套不同 schema。
2. 查看官方给出的 Neovim、Emacs、Zed 等通用 LSP client 示例。复制其中 `settings = {...}` 的内部对象；不要直接复制 VS Code 扩展专用字段。
3. 若文档只给出 VS Code 的扁平键（如 `yaml.format.enable`），按点号展开为嵌套 JSON；先确认该字段不是仅由 VS Code 扩展消费。
4. 文档不明确时，在 server 源码中搜索 `workspace/configuration`、`DidChangeConfiguration`、`section` 或动态 registration，或开启该 server 的协议日志查看其实际请求。server 发出的 `ConfigurationItem.section` 是最终依据。

当前内置 server 的主要官方入口：

- TypeScript Language Server：[Configuration](https://github.com/typescript-language-server/typescript-language-server/blob/master/docs/configuration.md)
- ty：[Editor settings](https://docs.astral.sh/ty/reference/editor-settings/)
- rust-analyzer：[Configuration](https://rust-analyzer.github.io/book/configuration)
- YAML Language Server：[Language server settings](https://github.com/redhat-developer/yaml-language-server#language-server-settings)
- clangd：主要使用项目或用户级 [`.clangd` configuration](https://clangd.llvm.org/config)，不要假设它采用上述 namespace 形式。

第三方 server 没有统一 section 注册表；应从该 server 的文档、官方 client 示例或源码确认，不能由 executable、server ID、language ID 或文件扩展名推导。

### 查找 language ID

language ID 是客户端在 `textDocument/didOpen.textDocument.languageId` 中发给 server 的字符串，不是 server ID、可执行文件名或扩展名；LSP 没有涵盖所有 server 的统一映射表。按以下顺序确认：

1. 查 server 的官方 README、client 配置或安装文档，搜索 `languageId`、`language ID`、`documentSelector`。
2. 查该 server 维护的编辑器扩展源码。VS Code 扩展通常在 `package.json` 的 `contributes.languages[].id` 声明 ID，并在启动 language client 时通过 `documentSelector` 选择它。
3. 查 server 源码中处理 `textDocument/didOpen` 的 `languageId`、`LanguageIdentifier` 常量或分支。可在源码目录运行 `rg 'languageId|LanguageIdentifier|documentSelector'`。
4. 仍不确定时开启已支持该 server 的编辑器的 LSP trace，查看实际发出的 `textDocument/didOpen` JSON；其中 `textDocument.languageId` 是最直接的依据。

不要仅根据文件扩展名猜测。例如 TypeScript React 常用 `typescriptreact`，Docker Language Server 使用 `dockerfile` 和 `dockercompose`。某些 server 会忽略 language ID 并只看 URI，但配置仍应使用其官方 client 或源码采用的值。

### Selector

Selector 使用受限 picomatch glob，并对规范化的 workspace-relative POSIX path 匹配：

- 不含 `/` 时匹配任意目录中的 basename；`compose.yaml` 和 `*.ts` 都可命中嵌套文件。
- 含 `/` 时匹配完整相对路径，例如 `deploy/**/*.yaml`。
- 支持 `*`、`?`、`[]`、`{yaml,yml}` 和 `**`；不支持 negation、extglob、绝对路径、反斜杠或 `..`。
- 匹配跨平台保持大小写敏感；例如 `*.c` 与 `*.C` 可以分别路由。
- 多个 selector 无法清晰合并时使用数组，例如 `["Chart.yaml", "deploy/**/*.yaml"]`。

Docker Language Server 可接管 Dockerfile、Containerfile 和 Compose 文件；通用 YAML server 作为 fallback 处理其余 YAML：

```jsonc
"docker": {
  "command": ["docker-language-server", "start", "--stdio"],
  "languages": {
    "dockerfile": [
      "{Dockerfile,Containerfile}",
      "?*.{Dockerfile,Containerfile}",
      "{Dockerfile,Containerfile}.?*"
    ],
    "dockercompose": [
      "{compose,docker-compose}.{yaml,yml}",
      "{compose,docker-compose}.?*.{yaml,yml}"
    ]
  }
},
"yaml": {
  "fallback": true,
  "command": ["yaml-language-server", "--stdio"],
  "languages": { "yaml": "*.{yaml,yml}" }
}
```

每个文件最多归属一个 server：一个普通 server 匹配时优先于所有 fallback server；多个普通 server、多个 fallback server 或同一 server 的多个 language ID 同时匹配均视为歧义。配置顺序不参与选择，歧义会让本次 LSP 增强安全降级并显示在 `/lsp status`。

这是唯一配置格式；没有格式版本、旧格式兼容层或内置 preset。用户配置也不需要 `$schema` 字段。

binary 不存在、TCP endpoint 不可达或 initialize 失败时 server 标记为 unavailable，文件工具继续成功执行。

## 行为

- `read`：部分行范围读取时可返回 `lsp.enclosing_symbol`；内容截断时可返回紧凑 `lsp.outline`，根和嵌套后代共同受全树 symbol 上限约束。outline 关闭或上限为 `0` 且不需要 enclosing symbol 时不会启动 LSP。只为 `documentSymbol` 打开的文档会在请求后关闭，但保留有界的本地内容版本和 symbol cache；相同内容的暖态读取直接复用 cache，不重新打开文档或发送 symbol 请求。
- `grep`：仅在 `match=auto` 且 query 像 symbol 时调用 workspace/symbol；请求范围来自完整 `ScopeInventory` 的 scope+glob allowed paths，不受本地解析或词法 Top-K 门控。多个 server 并行查询但按配置顺序稳定合并；symbol、resolve 和 reference 的结果由 grep 统一检查 scope、visibility、glob、live version/hash 和 range。`grep.references` 开启后只查询有效接收的 symbol，并以有界并发、全局去重和最终预算合并引用。调用方取消和统一操作 deadline 会贯穿 query、resolve、references 并触发协议级取消；所有 LSP 失败继续按独立文本链降级。
- `write`：写盘成功后先向已启动且 watcher 匹配的 server 发送 create/change 事件；配置文件不需要属于源码路由，也不会因此启动新 server。同一并行 mutation 批次按 client 合并 watcher 通知，随后先同步该 client 的全部文档。server 声明 `diagnosticProvider` 时以有界并发 pull diagnostics；未声明 pull 但公开 `typescript.tsserverRequest` 命令时走 TSLS 同步诊断 fast path；其余 server 并行等待 publish。诊断错误不改变 `status: "written"`。
- `edit`：preview 不调用 LSP；成功写盘后发送 watched-file change，并只用同一 workspace/server source 的编辑前 baseline 计算 diagnostics diff；不同 source 的 baseline 标记为 unknown，诊断错误不改变 `status: "applied"`。
- `ls` / `find`：不接入 LSP。

不会自动 apply code actions、organize imports、跨文件 rename。

### 协议 session

initialize 返回的 capabilities 会保存在 session 中；不支持的 document symbols、workspace symbols、workspace symbol resolve 或 references 不会发送请求。URI-only `WorkspaceSymbol` 仅在 `workspaceSymbolProvider.resolveProvider: true` 时通过 `workspaceSymbol/resolve` 补全 range。session 提供带超时和协议级取消的 typed request/notification 入口，并统一接收 diagnostics、日志和 progress。

文档同步严格遵循 server 的 `textDocumentSync`：Full 发送全文 change，Incremental 发送基于 UTF-16 position 的最小 replacement，None 不发送 change；仅在 `openClose` 启用时发送平衡的 didOpen/didClose，仅在 `save` 启用时发送 didSave，且只有 `includeText: true` 时携带全文。同一 URI 的同步、保存、关闭和 documentSymbol 请求按顺序执行。只读 symbol 请求使用临时 open/close，关闭后仍按内容版本保留本地 cache；mutation 会重新打开并持续同步目标文档。

Diagnostics 按 workspace/server source+URI 分区。pull full report 会更新当前及 related documents，并缓存 `resultId` 供后续增量请求；unchanged report 复用 ledger 快照。同一 client 的批量 mutation 在全部文档同步后才开始诊断请求，请求并发受限且共享本批次 deadline。TSLS fast path 按 capability 而不是 server ID 检测，依次请求 syntactic、semantic 和 suggestion diagnostics；成功的空数组是明确 clean，响应无效或请求失败时用剩余 deadline 回退等待 publish。无 pull capability 时，每次有效 publish 生成单调 revision，并保留可选文档 version；低于 client 当前文档版本的 publish 会被丢弃。diff 使用 severity/source/code/message 的位置无关身份和重复计数，已有问题随编辑移动时不会误报为新增和已解决。

并发启动共享同一个 initialize；取消或 deadline 只停止当前调用等待，不中断其他调用共享的启动。idle 只在没有活动请求或通知时计时。`reload` 先阻止新增强操作，等待旧 client 的完整操作链结束后再关闭。请求、通知、shutdown 和 transport 清理都有界；崩溃会立即清除 connection、文档状态和底层 socket/child，后续在 `max_restarts` 内创建全新 client，并发恢复共享同一次重启。stdio 持续消费 stderr 并只保留有界尾部用于 `last_error`；stdio initialize 使用当前 Pi PID，TCP initialize 使用 `processId: null`。

server 主动 request 仅内置处理无副作用的 `workspace/configuration`、`workspace/workspaceFolders`、`window/workDoneProgress/create` 和 `client/registerCapability`。动态注册白名单只有 `workspace/didChangeWatchedFiles` 与 `workspace/didChangeConfiguration`，watcher glob、workspace 边界和数量均受限；其他 request（包括 `workspace/applyEdit`）仍返回 `MethodNotFound`。

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

`/lsp status` 查看配置路径、server 状态、最后错误、打开文档数和最近 diagnostics 数。stdio stderr 只保留有界尾部，`last_error` 会折叠空白并截断为最多 1024 个字符，避免日志淹没状态输出。

常见 unavailable 原因：

- language server 未安装或不在 `PATH`；
- `command` / `args` 配置错误；
- TCP `host`/`port` 无效或 endpoint 未提供；
- initialize 超时或协议握手失败；
- server 启动后崩溃。

先运行 `/lsp status` 查看 `config_path`、server 状态和 `last_error`。配置 ID/扩展名冲突会在加载阶段拒绝整个 server 列表，修复配置后执行 `/lsp reload`。

这些情况不会让成功的文件读写搜索变成失败。
