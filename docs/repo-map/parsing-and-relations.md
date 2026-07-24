# 代码解析与关系构建

Repo Map 的关系来自受限、可解释的静态事实提取。它不是编译器级 name resolution，也不承诺完整覆盖动态 dispatch、条件导入或运行时 module resolution。

## 支持的语言

| 语言 | 扩展名 | 主要 symbol |
| --- | --- | --- |
| TypeScript / TSX | `.ts`、`.tsx` | function、method、class、interface、type、enum、declaration |
| JavaScript / JSX | `.js`、`.mjs`、`.cjs`、`.jsx` | function、method、class、declaration |
| Python | `.py` | function、class |
| Go | `.go` | function、method、type、var、const |
| Rust | `.rs` | function、struct、enum、type、trait、impl、const、static、module |
| C | `.c` | function、struct、enum、typedef、declaration |
| C++ | `.h`、`.cc`、`.cpp`、`.cxx`、`.hh`、`.hpp`、`.hxx` | function、method、class/struct、enum、alias/typedef、namespace、declaration |

C 和 C++ 使用不同 grammar；`.h` 静态归入 C++。`#include` 只记录源码中的 specifier 和 UTF-8 byte range，不解析编译器 include 语义。

语言 adapter registry 声明扩展名、grammar descriptor、AST unit 提取和 import 提取。新增语言需要 adapter、registry、grammar 依赖和测试，不需要修改核心 parser 分派。`text` 是 unsupported fallback，不属于 registry。

Tree-sitter runtime 和 grammar 通过 loader 按需加载，并在进程或 worker 内缓存。grammar 缺失或加载失败时保留 file node 和 diagnostic，不阻止其他文件建图。

## 解析事实

每个 symbol 保存：

- 稳定 symbol ID 和 file ID。
- kind、name、qualified name、signature。
- UTF-8 byte range 和行范围。
- visibility。
- definitions、references、calls 和 imports。

每个文件在扫描后、解析前再次校验 content hash，避免把变化中的源码写入 generation。解析失败只丢弃该文件的 symbol/import snapshot，不丢弃 file node。

## 基础关系

关系构建先连接 repository、file 和 symbol，再处理 export、call、reference 和 import：

- 顶层 export 根据语言语法或公开命名约定生成 `exports`。
- call/reference 优先寻找同一 scope、同一文件或全仓唯一 symbol。
- 候选不唯一或不存在时保留 `lexical:symbol:*`，不猜测具体定义。
- 相对 import 尝试当前语言扩展名和 `index.*`。
- 本地唯一目标形成 syntactic edge，否则保留 `external:*`。
- 保留字、过短 token、自引用和已作为 call 记录的重复 reference 会被过滤。

当前构建器主要生成 lexical 和 syntactic 关系；`semantic` 和 LSP source 是存储协议中的预留值。

## 架构图

Package 优先来自：

- `package.json` 的 `name`。
- `pyproject.toml` 的 `[project].name`。
- `go.mod` 的 module。
- `Cargo.toml` 的 `[package].name`。

每个嵌套 manifest 形成独立 package，文件归属最深的 package。没有 manifest 时，为非空仓库建立低置信度 repository package。

架构 entrypoint 包括：

- npm `main`、`module`、`bin`、递归展开的 `exports`、`scripts` 和 `test*` scripts。
- Python `[project.scripts]`。

无法解析的命令或 `module:function` target 仍保留 declared target，但 confidence 较低。

JavaScript/TypeScript 还识别静态注册：

- `registerCommand`。
- `registerTool({ name })`。
- `registerPlugin` / `registerExtension`。
- `export ... from` re-export。
- default export。

动态表达式保留文本并降低 confidence；注释和字符串中的伪代码不会生成 registration。`agent/extensions`、`extensions` 和 `plugins` 目录中的 default export 可形成低置信度 plugin convention。

公开 symbol 规则：

- JavaScript/TypeScript：顶层 `export`。
- Python：名称不以 `_` 开头。
- Go：名称首字母大写。
- Rust：`pub`。

manifest public target 和 re-export 会进一步生成 `exports-publicly`。

## 测试图

测试文件识别包括：

- `*.test.*`、`*.spec.*`、`test_*`、`*_test`。
- `test`、`tests`、`spec`、`specs`、`__tests__` 目录。

JavaScript-family 测试从 AST 提取 `describe`、`it`、`test`，包括 `.each(...)` 的静态名称；Python、Go、Rust 使用 `test_*` 或 `TestXxx` symbol。动态测试名称不生成命名 test node。

测试关系包括：

- 测试 import 和 source/test 同名约定 → `tests`。
- 测试名称唯一包含 symbol 名 → symbol-level `tests`。
- `vi.mock`、`jest.mock`、`mock.patch`、`patch` → `mocks`。
- fixture/testdata 路径 → `uses-fixture`。
- snapshot matcher 与 `__snapshots__` / `.snap` → `uses-snapshot`。
- package test scripts、Vitest、Jest、Playwright、Cypress、Karma、pytest/tox 配置 → `configured-by`。

测试图表示建议检查的关联，不代表测试实际运行、覆盖完整或断言正确。

## Lexical alias

alias 完全从当前仓库推导，不调用模型，也不生成开放式同义词。来源包括：

- 文件、目录、symbol、qualified name 和 signature。
- import/export alias。
- package、component、entrypoint 和 registration。
- config key、环境变量和 doc comment token。

camelCase、PascalCase、snake_case 和 kebab-case 会拆成 token 与短语。长度小于 3、纯数字和低信息量词会丢弃；每个 target 最多保留 96 条 alias。

只展开固定缩写：

| 输入 | canonical |
| --- | --- |
| `repo` | `repository` |
| `cmd` | `command` |
| `cfg` | `config` |
| `ctx` | `context` |
| `deps` | `dependencies` |
| `diag` | `diagnostics` |

每条 alias 保留 source、confidence 和 evidence。刷新时复核 content hash，删除或变化的目标不会遗留 alias。
