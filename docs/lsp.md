# LSP 内部增强

LSP 仅作为 `grep`、`read`、`write` 和 `edit` 的可选内部后端。它不会注册模型可见的 `lsp` 工具。

## 配置

默认配置与用户全局配置分别位于：

```text
agent/defaults/lsp.jsonc
agent/configs/lsp.jsonc
```

环境变量 `PI_LSP_CONFIG` 可更改用户全局配置的路径，但不会替换默认配置。若工作区根目录或其祖先中存在以下项目配置：

```text
<project>/.pi/configs/lsp.jsonc
```

项目配置优先于全局配置，未设置的字段继承全局配置。`diagnostics`、`read` 和 `grep` 按子字段合并。`servers` 按服务器 ID 合并，同一服务器的 `languages` 按语言 ID 合并，`init` 和 `settings` 中的对象递归合并。项目配置中的数组和标量整体替换全局值。项目配置可以覆盖现有服务器或新增服务器。

`PI_LSP_PROJECT_CONFIG` 可指定项目配置路径，`PI_LSP_PROJECT_ROOT` 可指定项目根目录。项目配置中的 `command` 会启动本地语言服务器，因此只应加载可信项目的配置。

顶层字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。设为 `false` 后不启动任何语言服务器，文件工具保持普通行为。 |
| `exclude_paths` | `["~"]` | 工作区根目录与列表中的路径完全匹配时不启动 LSP。路径中的 `~` 表示用户主目录。 |
| `startup_timeout_ms` | `8000` | 服务器 `initialize` 请求的超时时间，单位为毫秒，范围为 `100`-`60000`。超时后，服务器状态变为 `unavailable`。 |
| `request_timeout_ms` | `5000` | 单次 LSP 请求的超时时间，单位为毫秒，范围为 `100`-`60000`。适用于 `documentSymbol`、`workspace/symbol`、引用和调用层次结构等请求。 |
| `idle_timeout_ms` | `300000` | 服务器因空闲而关闭前的等待时间，单位为毫秒，范围为 `1000`-`3600000`。关闭后，下次文件工具调用会按需重启服务器。 |
| `max_open_documents` | `128` | 每个服务器会话最多保留的文档状态数，范围为 `1`-`1024`。按最近最少使用（LRU）策略淘汰文档时，客户端会先发送所需的 `didClose`，再清理全文和符号缓存。 |
| `diagnostics` | 见下表 | 控制 `write` 和 `edit` 成功后的诊断等待与返回内容。 |
| `read` | 见下表 | 控制 `read` 的长文件导航回退与包围符号增强。 |
| `grep` | 见下表 | 控制 `grep` 按需分析符号的入口与候选上限。 |
| `servers` | 见默认文件 | 以服务器 ID 为键的语言服务器对象，最多 50 个。 |

`diagnostics`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否在 `write` 或 `edit` 写盘成功后查询当前文件的诊断。关闭后不返回 `lsp.diagnostics`。 |
| `max_wait_ms` | `3000` | 拉取诊断请求或等待诊断发布的最长时间，单位为毫秒，范围为 `0`-`60000`。若未收到本次结果，即使存在旧快照也返回 `status: "timeout"`。 |
| `settle_ms` | `150` | 回退模式收到诊断发布后，等待结果稳定的时间，单位为毫秒，范围为 `0`-`5000`。每次收到新发布都会重新计时。拉取诊断报告不需要等待稳定。 |
| `max_items` | `8` | `write` 返回给模型和展开后终端界面的诊断条数。`edit` 对可归因问题使用同一上限，范围为 `0`-`100`。统计字段仍按文件中的全部诊断计算。 |
| `max_related_locations` | `3` | 每条诊断最多附加的相关位置数，范围为 `0`-`10`。相关位置写入现有 `message`，不会增加工具协议字段。 |
| `min_severity` | `"warning"` | 返回诊断的最低严重程度。可选值为 `"error"`、`"warning"`、`"information"` 和 `"hint"`。门槛越低，返回的诊断越多。 |

`read`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `outline` | `true` | 是否启用长文件导航回退。仅当整文件读取被截断，且可见片段中的顶层声明不超过总数的一半时，返回 `remaining_symbols`。 |
| `max_symbols` | `40` | `remaining_symbols` 最多返回的顶层符号数，范围为 `0`-`200`。不会递归返回子符号。部分范围读取的 `lsp.enclosing_symbol` 不受此开关影响。 |

`grep`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `workspace_symbols` | `true` | 是否允许 `grep` 在结构化查询多次命中或没有正文命中时，调用 `workspace/symbol` 选择待分析的符号。 |
| `max_symbols` | `20` | 范围与 URI 校验和去重后，最多接收的有效工作区符号数，范围为 `0`-`200`。范围外或解析失败的项目不占用上限。 |
| `max_exact_leaf_symbols` | `2` | 完全匹配末级名称时，最多接收的同名定义数，范围为 `0`-`200`。该设置不限制完全匹配的限定符号。 |

`servers` 的键是稳定的服务器 ID。ID 必须以字母开头，且只能包含字母、数字、`_` 和 `-`。每个服务器支持以下字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 单个服务器的开关。关闭后，服务器不参与文件路由，也不会建立连接。 |
| `fallback` | `false` | 与非回退服务器同时匹配时，由非回退服务器接管。适合 YAML 等通用后备服务器。 |
| `command` | 与 `tcp` 二选一 | 标准输入输出服务器的完整参数数组。第一个元素是可执行文件，其余元素是参数。命令不经过 shell。 |
| `tcp` | 与 `command` 二选一 | 连接用户提供的端点，例如 `{"host":"127.0.0.1","port":2087}`。Pi 不会启动 TCP 服务器。 |
| `languages` | 必填 | LSP 语言 ID 到一个选择器字符串或选择器数组的映射。 |
| `init` | 未设置 | 服务器定义的初始化 JSON。Pi 将其原样传给 `initialize.initializationOptions`，不定义其中的字段名和嵌套结构。 |
| `settings` | 未设置 | 服务器定义的运行时配置树。Pi 按配置节响应 `workspace/configuration`，并在初始化后通过 `workspace/didChangeConfiguration` 发送整个配置树。Pi 不会从 Go 项目配置或环境变量中补充设置。 |

配置不包含 `id`、`transport.type`、`args`、`extensions`、`language_id` 或 `language_ids` 等重复字段，也不会根据扩展名隐式推断语言 ID。合并后的全局配置与项目配置使用同一个 JSON Schema。项目中的服务器配置可以只提供需要覆盖的字段。

用户全局配置一旦包含 `servers`，就会整体替换默认服务器集合。项目配置随后按服务器 ID 与全局配置合并。默认配置包含以下标准输入输出服务器：TypeScript、HTML/Handlebars、JSON/JSONC、CSS/SCSS/Less、Python、Java（JDT LS）、Rust、Go（gopls）、Clangd（C/C++）、TexLab（LaTeX）、Tombi（TOML）、Docker 和 YAML。默认配置的注释还提供了 TCP 端点示例：

```jsonc
{
  "servers": {
    "typescript": {
      "command": ["tsc", "--lsp", "--stdio"],
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

内置 TypeScript 路由直接使用 TypeScript 7 原生语言服务器：`tsc --lsp --stdio`。该路由要求 `PATH` 中的 `tsc` 为 7.x。Pi 不会安装旧语言服务器，也不会回退到 tsserver。TypeScript 7 通过标准 LSP 的拉取诊断、文档符号、工作区符号、引用和调用层次结构接入。需要嵌入语言插件的项目应自行配置其他服务器。

内置 Java 路由使用 [`Eclipse JDT Language Server`](https://github.com/eclipse-jdtls/eclipse.jdt.ls) 的 `jdtls` 可执行文件，覆盖 `*.java`。JDT LS 要求使用 Java 21 或更高版本运行，但可以分析 Java 8 及以上项目。默认的 `settings.java` 启用 Maven 和 Gradle 导入、Gradle Wrapper、注解处理、自动构建与构建配置刷新。存在相关注解类型时，JDT LS 自动启用空值分析。工作区符号包含源码中的方法声明。引用查询包含访问器、声明和反编译源码，搜索范围包含主代码与测试代码。Pi 未声明 JDT LS 的私有扩展客户端能力，也不加载调试或测试组件，因为 Pi 当前只使用标准 LSP 诊断、符号、引用和调用层次结构。

内置 HTML、JSON 和 CSS 路由使用 [`vscode-langservers-extracted`](https://github.com/hrsh7th/vscode-langservers-extracted) 提供的 `vscode-*-language-server --stdio` 可执行文件：

- HTML 服务器覆盖 HTML 与 Handlebars，并启用和校验 `<style>`、`<script>` 中嵌入的 CSS 与 JavaScript。
- JSON 服务器覆盖 JSON、JSONC，以及 VS Code 官方声明的常见无扩展名配置文件。服务器直接读取 `file`、`http` 和 `https` 协议的 JSON Schema，并默认将 `package.json` 关联到 SchemaStore。
- CSS 服务器覆盖 CSS、SCSS 和 Less，并为三种语言启用校验。未设置的代码检查级别沿用 Microsoft 语言服务的默认值，不会将风格偏好固化为全局规则。

这些语言服务器的初始化参数和 `settings` 以 Microsoft 的以下资料为准：

- [HTML 服务器源码](https://github.com/microsoft/vscode/blob/main/extensions/html-language-features/server/src/htmlServer.ts)
- [JSON 服务器 README](https://github.com/microsoft/vscode/blob/main/extensions/json-language-features/server/README.md)
- [CSS 服务器源码](https://github.com/microsoft/vscode/blob/main/extensions/css-language-features/server/src/cssServer.ts)

Markdown 服务器需要客户端实现 `markdown/parse`、`markdown/fs/*` 和文件监视器等自定义协议，因此当前未列入默认配置。

内置 TOML 路由使用 `tombi lsp`，覆盖 `*.toml`，以及 Tombi 官方编辑器声明的 `Cargo.lock`、`Gopkg.lock`、`Pipfile`、`pdm.lock`、`poetry.lock` 和 `uv.lock`。默认的 `settings.tombi` 明确启用 SchemaStore、严格 JSON Schema 校验、诊断、引用，以及 Cargo、pyproject 和 Tombi 配置扩展。Tombi 优先使用项目级或用户级的 `.tombi.toml`、`tombi.toml` 与 `pyproject.toml`，因此仓库可以自行调整 TOML 版本、JSON Schema 和扩展功能。Pi 当前通过文件工具调用链使用文档符号和诊断；其他标准 LSP 能力不在当前范围内。

### `settings`、配置节与嵌套字段

不同语言服务器的 `settings` 没有统一结构。顶层键通常对应服务器请求的配置节。配置节名称由服务器实现决定，不是 Pi 的服务器 ID，也不是 `languages` 中的语言 ID。即使三类名称的拼写相同，也应分别理解：

```jsonc
{
  "servers": {
    "python": {                     // Pi 服务器 ID
      "command": ["ty", "server"],
      "languages": {
        "python": "*.py"           // textDocument/didOpen 的语言 ID
      },
      "settings": {
        "ty": {                     // workspace/configuration 配置节
          "diagnosticMode": "workspace"
        }
      }
    }
  }
}
```

Pi 按以下规则查找 `workspace/configuration`：

- 服务器请求 `section: "ty"` 时，返回 `settings.ty`。
- 服务器请求 `section: "ty.completions"` 时，返回 `settings.ty.completions`。
- 请求的配置节不存在时，返回 `null`。请求未指定配置节时，返回整个 `settings`。
- `scopeUri` 只用于确认请求仍位于当前工作区内。Pi 当前不支持按文件或目录覆盖 `settings`。

初始化完成后，Pi 还会将整个 `settings` 作为 `workspace/didChangeConfiguration.params.settings` 发送。因此，配置必须同时符合目标服务器对该通知与配置请求的约定。

嵌套对象完全由服务器定义。其他编辑器使用同名界面设置，不代表该设置可以作为 `init` 或 `settings` 发送。

官方配置文档中的点号字段通常表示 JSON 路径，而不是包含点号的字面键。例如：

| 官方字段 | `lsp.jsonc` 中的嵌套路径 |
| --- | --- |
| `ty.diagnosticMode` | `settings.ty.diagnosticMode` |
| `rust-analyzer.check.command` | `settings["rust-analyzer"].check.command` |
| `yaml.format.enable` | `settings.yaml.format.enable` |

按以下顺序确认配置节、字段名、类型和允许值：

1. 查阅目标服务器当前版本的官方配置文档。搜索 `workspace/configuration`、`workspace/didChangeConfiguration`、`settings`、`configuration section` 和 `initializationOptions`。`init` 与 `settings` 通常使用不同的结构。
2. 查看官方提供的 Neovim、Emacs 或 Zed 等通用 LSP 客户端示例。复制 `settings = {...}` 的内部对象，不要直接复制 VS Code 扩展的专用字段。
3. 若文档只给出 VS Code 的扁平键，例如 `yaml.format.enable`，则按点号展开为嵌套 JSON。展开前应确认该字段不是仅供 VS Code 扩展使用。
4. 若文档没有明确说明，则在服务器源码中搜索 `workspace/configuration`、`DidChangeConfiguration`、`section` 或动态注册相关代码。也可以开启服务器的协议日志，查看实际请求。服务器发出的 `ConfigurationItem.section` 是最终依据。

默认语言服务器的主要官方资料：

- TypeScript 7：[官方发布说明](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) 与 [原生实现](https://github.com/microsoft/typescript-go)
- Eclipse JDT LS：[项目 README](https://github.com/eclipse-jdtls/eclipse.jdt.ls) 与 [Java 设置](https://github.com/redhat-developer/vscode-java#supported-vs-code-settings)
- ty：[编辑器设置](https://docs.astral.sh/ty/reference/editor-settings/)
- rust-analyzer：[配置](https://rust-analyzer.github.io/book/configuration)
- gopls：[设置](https://go.dev/gopls/settings)
- clangd：[`.clangd` 配置](https://clangd.llvm.org/config)。clangd 主要使用项目级或用户级 `.clangd`，不能假设它采用前述命名空间形式。
- TexLab：[配置](https://github.com/latex-lsp/texlab/wiki/Configuration)
- HTML Language Server：Microsoft VS Code 的 [HTML 服务器](https://github.com/microsoft/vscode/tree/main/extensions/html-language-features/server)
- JSON Language Server：Microsoft VS Code 的 [JSON 服务器](https://github.com/microsoft/vscode/tree/main/extensions/json-language-features/server)
- CSS Language Server：Microsoft VS Code 的 [CSS 服务器](https://github.com/microsoft/vscode/tree/main/extensions/css-language-features/server)
- Docker Language Server：[项目仓库](https://github.com/docker/docker-language-server)
- YAML Language Server：[服务器设置](https://github.com/redhat-developer/yaml-language-server#language-server-settings)
- Tombi：[配置](https://tombi-toml.github.io/tombi/docs/configuration/) 与 [语言服务器](https://tombi-toml.github.io/tombi/docs/language-server/)

第三方服务器没有统一的配置节注册表。应查阅服务器文档、官方客户端示例或源码，不能根据可执行文件、服务器 ID、语言 ID 或文件扩展名推导配置节。

### 查找语言 ID

语言 ID 是客户端通过 `textDocument/didOpen.textDocument.languageId` 发送给服务器的字符串。它不是服务器 ID、可执行文件名或扩展名。LSP 没有覆盖所有服务器的统一映射表。按以下顺序确认语言 ID：

1. 查阅服务器的官方 README、客户端配置或安装文档，搜索 `languageId`、`language ID` 或 `documentSelector`。
2. 查看服务器维护的编辑器扩展源码。VS Code 扩展通常在 `package.json` 的 `contributes.languages[].id` 中声明 ID，并在启动语言客户端时通过 `documentSelector` 选择 ID。
3. 查看服务器源码中处理 `textDocument/didOpen` 的 `languageId`、`LanguageIdentifier` 常量或分支。可以在源码目录运行 `rg 'languageId|LanguageIdentifier|documentSelector'`。
4. 若仍无法确定，则开启已支持该服务器的编辑器的 LSP 跟踪日志，查看实际发送的 `textDocument/didOpen` JSON。其中的 `textDocument.languageId` 是最直接的依据。

不要只根据文件扩展名猜测语言 ID。例如，TypeScript React 通常使用 `typescriptreact`，Docker Language Server 使用 `dockerfile` 和 `dockercompose`。某些服务器会忽略语言 ID，只检查 URI。配置仍应使用官方客户端或服务器源码采用的值。

### 选择器

选择器使用受限的 picomatch glob，并匹配规范化后的工作区相对 POSIX 路径：

- 选择器不含 `/` 时，匹配任意目录中的文件名。`compose.yaml` 和 `*.ts` 都可以匹配嵌套目录中的文件。
- 选择器包含 `/` 时，匹配完整的相对路径，例如 `deploy/**/*.yaml`。
- 支持 `*`、`?`、`[]`、`{yaml,yml}` 和 `**`。不支持否定模式、扩展 glob、绝对路径、反斜杠或 `..`。
- 所有平台都区分大小写。例如，`*.c` 与 `*.C` 可以分别路由。
- 多个选择器无法清晰合并时，使用数组，例如 `["Chart.yaml", "deploy/**/*.yaml"]`。

Docker Language Server 可以接管 Dockerfile、Containerfile 和 Compose 文件。通用 YAML 服务器作为回退服务器处理其他 YAML 文件：

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

每个文件最多归属一个服务器。非回退服务器与回退服务器同时匹配时，优先选择非回退服务器。多个非回退服务器、多个回退服务器，或同一服务器的多个语言 ID 同时匹配，均视为歧义。配置顺序不影响选择。发生歧义时，本次 LSP 增强会降级，并在 `/lsp status` 中显示原因。

本节描述的是唯一配置格式。配置没有格式版本、旧格式兼容层或内置预设。用户配置不需要 `$schema` 字段。

可执行文件不存在、TCP 端点不可达或初始化失败时，服务器状态变为 `unavailable`。文件工具本身仍可成功执行。

服务器在进入 `ready` 后崩溃时，状态保持为 `crashed`，不会自动创建替代客户端。`read`、`grep`、`write` 和 `edit` 继续沿用 LSP 不可用时的降级路径；修复服务器或配置后执行 `/lsp reload`，下一次文件工具调用会按需建立新连接。

## 文件工具行为

- `read`：读取部分行范围时，若最小包围符号的声明行不可见，可以返回 `lsp.enclosing_symbol`。仅当整文件读取被截断，且可见片段未覆盖大部分顶层声明时，才返回非递归的 `remaining_symbols`，用于长文件导航回退。若 `outline` 已关闭或 `max_symbols` 为 `0`，且不需要包围符号，则不会启动 LSP。仅为 `documentSymbol` 打开的文档会在请求后关闭，但会保留数量受限的本地内容版本与符号缓存。相同内容的后续读取直接复用缓存，不会重新打开文档或发送符号请求。
- `grep`：正文扫描期间预热候选文件对应的 LSP 服务器，扫描完成后调用一次分析器。有正文命中时，分析器对命中文件请求文档符号、引用和传入调用。没有正文命中时，分析器先请求工作区符号，并从 `ScopeInventory` 的范围和 glob 模式允许的路径中选择数量受限的候选，然后发出相同的文档与关系请求。文件正文仅由 `grep` 中与快照绑定的加载器提供。只有全部目标均完成映射时，才采用 LSP 结果。若必要能力不可用、请求失败、响应不完整或请求超时，则整次分析回退到 Tree-sitter，不会混用部分 LSP 结果。调用方取消与统一的操作截止时间作用于整个请求链，并会触发协议级取消。
- `write`：写盘成功后，先向已启动且文件监视器匹配的服务器发送创建或更改事件。配置文件不需要属于源码路由，也不会因此启动新服务器。同一批并行修改按客户端合并监视器通知，然后同步该客户端的全部文档。服务器声明 `diagnosticProvider` 时，Pi 以受限并发拉取诊断。其他服务器并行等待诊断发布。诊断失败不会改变 `status: "written"`。
- `edit`：预览不调用 LSP。成功写盘后，Pi 发送受监视文件的更改事件，并且只使用同一工作区和服务器来源的编辑前基线计算诊断差异。基线已知时，只返回新增错误和修改范围内的新增警告。基线未知时，只返回修改范围或所属符号内的错误，并标记 `causality uncertain`。`edit` 的模型输出不包含原有问题、已解决问题、`clean`、`total` 或文件级统计。来源不同的基线标记为 `unknown`。诊断失败不会改变 `status: "applied"`。
- `ls` 和 `find`：不接入 LSP。

LSP 增强不会自动应用代码操作、整理导入或执行跨文件重命名。

### 协议连接

客户端会保存 `initialize` 返回的能力。若服务器不支持文档符号、工作区符号、工作区符号解析、引用或调用层次结构，Pi 不会发送对应请求。仅含 URI 的 `WorkspaceSymbol` 只有在 `workspaceSymbolProvider.resolveProvider: true` 时，才通过 `workspaceSymbol/resolve` 补全范围。

`grep` 分析器要求服务器同时支持文档符号、引用和传入调用。没有正文命中时，服务器还必须支持工作区符号。客户端为生产所需请求提供带超时与协议级取消的类型化接口，并接收诊断通知；不声明或消费 work-done progress，也不提供通用通知转发。

文档同步严格遵循服务器的 `textDocumentSync`：

- `Full` 发送全文更改。
- `Incremental` 发送基于 UTF-16 位置的最小替换范围。
- `None` 不发送更改。

仅在 `openClose` 启用时，客户端才按正常文档生命周期发送 `didOpen` 和 `didClose`。仅在 `save` 启用时发送 `didSave`，且只有 `includeText: true` 时携带全文。同一 URI 的同步、保存、关闭与 `documentSymbol` 请求按顺序执行。只读符号请求会临时打开文档，并在请求后关闭文档。关闭后，本地缓存仍按内容版本保留。文件修改会重新打开目标文档并持续同步。整个协议连接退出时直接执行 `shutdown` 和 `exit`，不会批量发送多余的 `didClose`。

诊断按工作区、服务器来源和 URI 分区。完整的拉取报告会更新当前文档与相关文档，并缓存 `resultId` 供后续增量请求使用。未更改报告复用已有诊断快照。同一客户端批量修改文件时，只有全部文档同步完成后才开始请求诊断。诊断请求使用受限并发，并共享本批次的截止时间。

服务器不支持拉取诊断时，每次有效发布都会生成单调递增的修订号，并保留可选的文档版本。低于客户端当前文档版本的发布会被丢弃。诊断差异将 `severity`、`source`、`code` 和 `message` 作为不含位置的标识，并对重复项计数。已有问题随编辑移动时，不会被误报为新增问题和已解决问题。

`LspManager` 属于 Pi 进程，并按工作区和服务器持有客户端。Pi 对话中的 `/new`、分叉和恢复只重建会话级扩展状态，不会关闭进程级 LSP。只有扩展重新加载、`/lsp reload` 和进程退出会重置管理器。重新加载完成后，管理器仍可按需创建新连接。

每次从 `initialize` 到 `shutdown` 构成一个独立的连接代。每个连接代独占 JSON-RPC 写入器、连接和传输层。并发启动共享同一个初始化过程。取消或截止时间只停止当前调用的等待，不会中断其他调用共享的启动过程。仅当没有活动请求或通知时，才计算空闲时间。

`reload` 会先阻止新的增强操作，等待旧客户端的完整操作链结束，再关闭客户端。优雅退出时，客户端停止接收新操作，并在同一个绝对期限内依次执行以下步骤：发送 `shutdown` 和 `exit`，排空写入器，结束写入端，等待服务器自行退出。超时后，客户端关闭套接字，或向子进程发送 `TERM` 和 `KILL`。

流写入错误由所属连接代统一处理，并转换为一次传输失败。旧连接的延迟回调不能影响新连接。服务器崩溃时，客户端跳过协议退出流程，立即清除连接、文档状态与底层套接字或子进程，并保持 `crashed` 状态。后续操作不会自动创建替代客户端；执行 `/lsp reload` 后，下一次文件工具调用才会按需建立全新连接。

标准输入输出传输会持续读取标准错误，但只为 `last_error` 保留长度受限的末尾内容。使用标准输入输出初始化时，`processId` 是当前 Pi 进程 ID。使用 TCP 初始化时，`processId` 为 `null`。

对于服务器主动发起的请求，Pi 仅处理无副作用的 `workspace/configuration`、`workspace/workspaceFolders` 和 `client/registerCapability`。动态注册白名单只包含 `workspace/didChangeWatchedFiles` 与 `workspace/didChangeConfiguration`。文件监视器的 glob、工作区边界和数量均受限制。其他请求，包括 `workspace/applyEdit`，返回 `MethodNotFound`。

## 命令

```text
/lsp
/lsp status
/lsp reload
/lsp diagnostics [path]
```

`/lsp` 等价于 `/lsp status`。`reload` 会关闭所有服务器并清空诊断记录。`diagnostics` 显示工作区或指定文件的已知诊断。

## 故障排查

`/lsp status` 显示配置路径、服务器状态、最后错误、打开的文档数和最近的诊断数。标准输入输出服务器的标准错误只保留长度受限的末尾内容。`last_error` 会折叠空白，并截断到最多 1024 个字符，避免日志占满状态输出。

服务器状态变为 `unavailable` 的常见原因：

- 语言服务器未安装或不在 `PATH` 中。
- `command` 配置错误。
- TCP `host` 或 `port` 无效，或端点不可用。
- `initialize` 超时或协议握手失败。
- 服务器在初始化期间退出。

先运行 `/lsp status`，查看 `config_path`、服务器状态和 `last_error`。无效的服务器 ID 或选择器会使配置在加载阶段被拒绝。修复配置后，执行 `/lsp reload`。

这些错误不会使原本成功的文件读取、写入或搜索操作失败。
