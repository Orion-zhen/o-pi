# 代码解析与关系构建

Repo Map 从受限、可解释的静态事实构建关系。它不是编译器级 name resolution，不覆盖动态 dispatch、条件导入或运行时 module resolution。

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

C 和 C++ 使用不同 grammar；`.h` 静态归入 C++。`#include` 只记录 `preproc_include` AST 节点中的 specifier 和 UTF-8 byte range，不解析编译器 include 语义。

语言 adapter registry 声明扩展名、grammar descriptor、AST unit 提取和 import 提取。新增语言需要 adapter、registry、grammar 依赖和测试；`text` 是 unsupported fallback，不属于 registry。

Tree-sitter runtime 和 grammar 按请求延迟加载，并在进程或 worker 内按 descriptor 缓存。缺失、不兼容或错误 export 的 grammar 只影响对应文件，其他语言继续建图。

## 一次解析与源码坐标

`analyzeCodeFile()` 建立短生命周期的 `ParsedDocument`：它包含 Tree-sitter root、原文和共享 `SourceIndex`。同一调用链内，adapter 从 root 产出 code units/imports，Repo Map 再从同一 root 产出 JavaScript syntax facts；native tree 不跨 generation 或 worker 持久化。

`SourceRange` 始终为 1-based inclusive line 和 UTF-8 `[startByte,endByte)`。Tree-sitter JS binding 的 UTF-16 char offset 通过 `SourceIndex` 转换：ASCII 文件直接使用 O(1) 偏移，非 ASCII 文件为整篇文本建立一次 char→byte 映射。unit 内容按 char range slice，避免每个 symbol 重新编码整文件。

每个 symbol 保存：

- 稳定 symbol ID 和 file ID。
- kind、name、qualified name、signature。
- UTF-8 byte range、行范围和结构化 `exported` boolean。
- definitions、references、calls。

每个文件在扫描后、解析前再次校验 content hash，避免把变化中的源码写入 generation。解析失败保留 file node 和结构化 diagnostic，只丢弃该文件的 symbol/import snapshot。

## AST imports

imports 不再来自源码正则，而是由各语言 adapter 从同一 AST root 返回 `RawImport`，核心统一转换 range、去重和排序：

- JavaScript/TypeScript：静态 `import`、`export ... from`、字符串字面量 `require()`、字符串字面量 dynamic `import()`；忽略注释、字符串伪代码和动态参数。
- Python：`import`、`from ... import`，包含 grouped module 和 alias 的每个 module target。
- Go：单条、block、alias 和 raw-string import。
- Rust：递归展开 grouped/scoped/aliased `use`。
- C/C++：只读取 `preproc_include`。

这些 file-level import facts 保留 AST range 和 specifier；不承诺 module resolution、条件 import 或动态加载的运行时语义。

## 基础关系

关系构建先连接 repository、file 和 symbol，再处理 export、call、reference 和 import：

- 相对 import 尝试当前语言扩展名和 `index.*`；唯一目标形成 syntactic edge，否则保留 `external:*`。
- call/reference 优先寻找同一 scope、同一文件或全仓唯一 symbol；候选不唯一或不存在时保留 `lexical:symbol:*`。
- 保留字、过短 token、自引用和已作为 call 记录的重复 reference 会被过滤。
- 当前构建器主要生成 lexical 和 syntactic 关系；`semantic` 和 LSP source 是存储协议中的预留值。

## 结构化 visibility 与架构图

`exported` 在 code-index adapter 阶段确定，不从 signature 或展示文本猜测：

- JavaScript/TypeScript：语法上的顶层 `export`，包括每个 export variable declarator。
- Rust：语法 visibility node 的 `pub`。
- Python：名称不以 `_` 开头。
- Go：名称首字母大写。
- C/C++：当前不声明 Repo Map module export。

Repo Map 通过唯一的 visibility helper 判断公开 symbol；relationship 和 architecture 共用该 boolean，不重复解析 signature。qualified symbol、嵌套 scope 和 method range 仍由 adapter 的 AST 规则决定。

Package 优先来自 `package.json`、`pyproject.toml`、`go.mod` 和 `Cargo.toml`。每个嵌套 manifest 形成独立 package，文件归属最深的 package；没有 manifest 时为非空仓库建立低置信度 repository package。

JavaScript/TypeScript architecture facts 包括 `registerCommand`、`registerTool({ name })`、`registerPlugin`/`registerExtension`、re-export 和 default export。动态表达式保留文本并降低 confidence；注释和字符串中的伪代码不会生成 registration。manifest public target 和 re-export 可进一步形成 `exports-publicly`。

## Parser failure 与降级

稳定 failure code 包括：`RUNTIME_UNAVAILABLE`、`GRAMMAR_UNAVAILABLE`、`GRAMMAR_EXPORT_INVALID`、`GRAMMAR_INCOMPATIBLE`、`PARSER_INITIALIZATION_FAILED`、`PARSER_EXCEPTION` 和 `PARSER_TIMEOUT`。公开 `AnalyzedFileIndex.status` 对解析失败为 `error`，message 保留可操作原因。

Grep 在 Tree-sitter 不可用、超时或解析异常时退化为文本索引；Repo Map 保留 file node、生成 `PARSER_ERROR` 或 `FILE_CHANGED_DURING_PARSE`，并继续处理其他文件。malformed AST 对 code units 保持宽容，对 Repo Map syntax facts 严格返回空 facts。直接调用 architecture/test indexer 或未收到 transient facts 时，仍可按需读取并解析源码。

## 测试图

测试文件识别包括 `*.test.*`、`*.spec.*`、`test_*`、`*_test` 以及 `test`、`tests`、`spec`、`specs`、`__tests__` 目录。JavaScript-family 测试从 AST 提取 `describe`、`it`、`test`、mock、fixture 和 snapshot facts；动态测试名称不生成命名 test node。

测试图表示建议检查的关联，不代表测试实际运行、覆盖完整或断言正确。测试 relationship 包括 `tests`、`mocks`、`uses-fixture`、`uses-snapshot` 和 `configured-by`。

## Lexical alias

alias 完全从当前仓库推导，不调用模型，也不生成开放式同义词。来源包括文件、symbol、signature、import/export alias、package、component、entrypoint、registration、config key、环境变量和 doc comment token。刷新时复核 content hash，删除或变化的目标不会遗留 alias。
