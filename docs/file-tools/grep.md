# `grep`

`grep` 检索正文并返回聚合后的代码区域。它不负责查找路径，也不修改文件。执行链固定为：

```text
查询计划
-> 范围文件清单
-> 稳定正文扫描 + 并行预热 LSP
-> 完整的 LSP 分析事务
   或完整回退到 Tree-sitter
-> 确定性排序
-> 相关性头部/MMR 打包
```

每个已验证结果都来自当前正文中的真实逐行命中。合法查询按 ECMAScript 正则执行。对于非法正则，系统只探测完全相同的字面量。字面量直接命中正文时，结果会明确标记为 `literal_fallback`。没有直接命中时，系统返回 `INVALID_REGEX`，不会把错误伪装成零结果，也不会查找相关结果。

只要 LSP 能处理本次调用的全部结构分析目标，并具备所需能力，正则、字面量回退、唯一命中、多命中和零命中都会优先采用 LSP。任何部分失效时，系统都会丢弃整次 LSP 事务，并改用 Tree-sitter 重新执行完整分析。正文没有命中时，按固定规则提取的查询词可以形成明确标记的相关结果。

## 参数

```json
{
  "query": "Auth(Service|Client)",
  "path": ["src", "tests"],
  "glob": "**/*.{ts,tsx}"
}
```

- `query`：区分大小写，逐逻辑行执行。合法的 ECMAScript 正则按正则匹配，不支持跨行。非法正则只有在完全相同的字面量直接命中正文时才会降级。
- `path`：非空的目录或普通文件范围数组，默认为 `["."]`。多个范围取并集。
- `glob`：相对每个 `path` 解释的候选文件 glob，只缩小范围。不含 `/` 时递归匹配基础名称，含 `/` 时匹配范围相对路径。
- 相对路径按 `cwd` 解析。目录会递归检索，普通文件只检索该文件。
- `path: []`、空路径和包含 CR 或 LF 的查询非法。无效正则没有完全相同的字面量命中时也非法。

`grep` 没有匹配模式参数，也不分类标识符、长文本、自然语言或关系意图。

## 候选

### 正文命中

系统通过一次稳定的正文读取，在所有文件中执行已解析的查询。合法正则直接执行。非法正则使用完全转义后的字面量匹配器探测。只有整次扫描至少产生一个直接命中时，系统才接受降级。

对于大小未超过结构分析限制的代码文件，系统会一次性读取并解码，然后保留当前快照的正文，供 LSP 或 Tree-sitter 直接复用。普通文本和大文件继续采用流式逐行扫描。命中受支持的代码时，选定的结构分析器会把同一最小代码单元中的命中聚合为一个已验证区域。无法解析或没有语法归属的命中仍以文本行表示。

字面量回退的成功正文会在结果开始处显示警告：

```text
<grep>
warning: invalid regex; exact literal fallback used
src/parser.ts:42: const value = read(input);
</grep>
```

`details.query_mode` 为 `regex` 或 `literal_fallback`。回退区域的 `matched_by` 为 `literal`，`source` 为 `text-literal`。

### 符号分析与零命中回退

正文扫描期间，`grep` 会并行预热文件清单涉及的 LSP 服务器。扫描完成后，系统调用一次 LSP 分析器：

1. 有正文命中时，文档符号请求将所有命中映射到最小的标准化代码单元。
2. 没有正文命中时，工作区符号请求在本次成功扫描的代码路径中选择有界候选，再由文档符号请求建立代码单元。
3. 系统通过传入调用请求和引用请求，判断其他代码单元是否调用或引用每个选中的定义。
4. 分析器只能通过 `grep` 提供的快照绑定加载器读取文件。
5. 系统必须整体校验返回的 `coveredPaths`、文档哈希、分析状态、文件路径和字节范围。

LSP 结果先保存在临时事务中。只有所有目标路径、服务器、能力和请求全部成功后，系统才会一次性提交结果。出现以下任一情况时，系统会丢弃全部 LSP 中间结果：服务器不可用，请求失败或超时，结果失效，或返回结果未覆盖全部目标路径。相关请求包括文档符号、引用、调用层次和工作区符号。

如果 LSP 事务失败，Tree-sitter 会复用已稳定读取的正文进行完整分析，不与部分 LSP 结果拼接。协议定义的空符号、引用或调用结果仍属于完整结果，系统不会仅因结果为空而回退。用户取消会直接终止操作，不会启动回退。

正文没有命中且没有可用的 LSP 结果时，Tree-sitter 使用扫描阶段保存的有限行锚点。名称、签名、结构词元和锚点达到固定覆盖率后，系统形成词法相关区域。回退过程不解释调用方、被调用方、测试、夹具、模拟对象、注册或入口点等词义。没有合格证据时，结果仍可为空。

## 排序

排序只使用候选自身证据和代码关系，不检查或推断 `src`、`tests`、`spec`、fixture、mock 等路径上下文。LSP 可用时，存在外部调用的定义优先于只有外部引用的定义，后者优先于仅被定义的代码单元。因此真正参与功能调用链的代码通常排在只声明、只验证或未被调用的同名代码之前。

稳定比较顺序为：

```text
查询层级 + 权威等级
-> BM25F 字段分数
-> 来源排名分数
-> 已验证覆盖率
-> 较小区域
-> 路径
-> 起始行
-> 结束行
-> 区域标识
```

查询层级从强到弱依次覆盖：

1. 精确匹配的限定名称或符号定义。
2. 精确成员匹配、符号前缀匹配，以及结构化符号或路径查询词覆盖。
3. 已验证的短语、正文、限定名称出现位置或包围区域。
4. 已验证的文本行。
5. 高覆盖率的词法相关结果。
6. 其他合格的词法相关结果。

每个查询层级内再按 `called -> referenced -> defined -> unknown` 划分权威等级带。LSP 可以根据跨代码单元的传入调用或引用提升权威等级。Tree-sitter 构造保守的词法依赖图，也可以将唯一解析的目标提升为 `called` 或 `referenced`。外部关系必须来自候选自身范围之外，同一声明内部的自引用不计入提升。

同一结构层级的 BM25F 字段依次覆盖叶子符号、限定符号或所有者、路径、声明或签名，以及命中正文。正则或字面量命中只用于确认候选真实命中，不会把文件遍历位置当作相关性依据。排序不推断 `src` 或 `tests` 的语义，也不按词元成本重排。

## 输出

成功结果使用紧凑文本：

```text
<grep>
src/auth/service.ts:41-88 AuthService.login
  async login(credentials: Credentials): Promise<Session>
  42: async login(credentials: Credentials): Promise<Session> {

src/session/cache.ts:12-46 SessionCache.restore [not match, related]
  restore(key: SessionKey): Promise<Session | undefined>
  29: const cachedSession = await this.storage.load(key);
</grep>
```

已验证区域保留完整且唯一的 `match_lines`。`grep_regional_display_limit` 只限制每个区域展示的代表行数。声明和代表行最多包含 240 个 Unicode 码点。完整源码通过 `read({ path: "...", lines: "N-M" })` 返回。

代码区域的模型正文只展示路径和范围、可选符号、无标签声明和代表行。相关区域追加 `[not match, related]`。`kind`、`roles`、`matched_by` 和字段名只保留在 `details` 与内部排序数据中，不重复进入模型文本。未展示的已验证匹配以 `+N match lines` 标记。

同一文件中连续的 `kind=text` 区域在模型文本和 `grep` 工具组件的展开视图中只显示一次文件路径，随后逐行展示。该压缩只发生在呈现器中。每行仍是独立候选和独立区域，分别参与排序与选择，不受 `grep_regional_display_limit` 的额外限制。`details` 不合并这些区域。

相关性排序完成后，`grep_related_result_limit` 先保留前 N 个相关区域，但不在模型输出中提示该限制。默认值为 8，设为 0 可禁用相关结果。被该限制过滤的候选不计入模型可见的 `total_candidates`，也不会触发 `truncated_by` 或省略提示。已验证区域不消耗相关结果配额。

剩余候选再受 `grep_result_limit` 限制。候选超过限制时：

- 前 4 条相关性头部结果原样保留，其余名额只在同一层级内使用 MMR 选择互补候选。
- `truncated_by` 包含 `result_limit`。
- 开始标签显示 `<grep truncated="result_limit">`。
- 结尾显示省略的低排名候选数量。

`grep` 不会根据模型输出的词元数删除、替换或重排结果。`approx_tokens` 只用于观测。

其他 `truncated_by` 原因来自上游搜索边界：

- `depth_limit`：搜索范围达到 `grep_max_depth`。
- `entry_limit`：所有目录范围共享的遍历量达到 `grep_max_entries`。
- `byte_limit`：累计文件快照大小达到 `grep_max_search_bytes`。

正文命中、相关锚点、不会显示的相关结果限额，以及 AST 增强的内部容量不进入 `truncated_by`。`details.stats` 记录 `text_hits`、`dropped_text_hits`、`dropped_related_anchors`、`dropped_related_results` 和 `ast_skipped_oversized_files`。遥测投影使用对应的 `*_count` 字段。

`details.ranking` 只供遥测使用，记录以下信息：

- 算法标识
- 相关结果限额生效前后的候选数
- 排序层级和相关性头部
- MMR 替换数
- 纯相关性前缀与最终选择的文件覆盖
- 每个可见区域的原始相关性排名、层级、主分数、辅助分数和选择阶段

模型正文和 TUI 区域不显示这些内部评分。

## 文件与解析语义

有正文命中时，LSP 分析器要求所有目标服务器同时支持文档符号、引用和调用层次。没有正文命中时，还要求服务器支持工作区符号。所有能力必须在执行前满足。候选数量和并发数有固定上限，并复用现有的 LSP 截止时间。

LSP 无法完整提交时，C/C++、TypeScript、TSX、JavaScript、JSX、Python、Go、Rust 和 Bash 会全部改用 Tree-sitter。语言、扩展名和语法来自共享目录。新增的目录注册项会自动获得代码索引 AST 适配器。专用语义适配器会进一步提取符号、导入和调用。未注册的语言或解析失败会退化为文本行。

每次调用都使用主机已绑定的可见性状态。文件清单构建会在目录枚举时增量加载嵌套规则，并应用范围、glob、受阻路径、软忽略规则和深度限制，再按规范身份去重。递归搜索不跟随子符号链接。

文件清单条目携带对象身份、版本和大小快照。逐行扫描和 AST 读取都要求快照稳定。文件发生变化时，系统不会保留部分命中。LF、CRLF、CR 和 UTF-8 BOM 使用统一的逻辑行语义。范围使用剥离 BOM 后正文的 UTF-8 字节坐标。

正文扫描按文件清单顺序预留文件快照所需空间。下一个文件无法完整纳入 `grep_max_search_bytes` 时，扫描停止。后续 LSP 或 Tree-sitter 增强只处理已纳入预算的文件。

`grep_ast_max_file_bytes` 限制 LSP 和 Tree-sitter 结构增强以及单文件缓存资格。`grep_content_cache_bytes` 与 `grep_content_cache_entries` 分别限制跨调用正文 LRU 缓存的总字节数和文件数。缓存限制不会裁剪搜索。任一缓存限制设为 `0` 时，正文缓存禁用。

## 零结果

正文和相关结果回退都没有合格候选时：

```text
<grep>
none
searched=12; skipped=0
next: refine query/path/glob
</grep>
```

## 失败

常见失败：

| code | 条件 |
| --- | --- |
| `INVALID_OPERATION` | `query` 为空，或包含 NUL、CR 或 LF |
| `INVALID_REGEX` | `query` 不是合法正则，且完全相同的字面量探测没有直接命中 |
| `INVALID_PATH` | `path` 或 `glob` 非法 |
| `PATH_NOT_FOUND` | 搜索范围不存在 |
| `PROTECTED_PATH` | path 被配置阻止 |
| `BINARY_FILE_UNSUPPORTED` | 显式文件是二进制 |
| `ENCODING_UNSUPPORTED` | 显式文件不是有效 UTF-8 |
| `OPERATION_ABORTED` | 调用被取消 |
