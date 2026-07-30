# `grep`

`grep` 按正文检索并返回聚合后的代码区域，不查找路径、不修改文件。执行链固定为：

```text
QueryPlan
-> ScopeInventory
-> stable text scan + parallel LSP warmup
-> complete LSP analysis transaction
   or full Tree-sitter fallback
-> deterministic ranking
-> relevance-head/MMR packing
```

每个 verified 结果都来自当前正文中的真实逐行命中。合法 query 按 ECMAScript 正则执行；非法正则只探测完全相同的 literal，存在直接命中时返回明确标记的 `literal_fallback`，否则仍返回 `INVALID_REGEX`，不伪装成零结果或启动 related 回退。只要 LSP 对本次全部结构目标可用并具备完整能力，正则、literal fallback、唯一命中、多命中和零命中都优先采用 LSP；任何部分失效都会丢弃整次 LSP 事务并由 Tree-sitter 完整重跑。零正文命中时允许机械词项形成明确标记的 related 结果。

## 参数

```json
{
  "query": "Auth(Service|Client)",
  "path": ["src", "tests"],
  "glob": "**/*.{ts,tsx}"
}
```

- `query`：区分大小写、逐 logical line 执行；合法 ECMAScript 正则按正则匹配，不支持跨行。非法正则仅在 exact literal 有直接正文命中时降级。
- `path`：非空目录或普通文件 scope 数组，默认 `["."]`；多个 scope 是 OR/union。
- `glob`：相对每个 path 的候选文件 glob，只缩小范围；不含 `/` 时递归匹配 basename，含 `/` 时匹配 scope-relative path。
- 相对路径按 `cwd` 解析；目录递归检索，文件只检索该文件。
- `path: []`、空 path 和 CR/LF query 非法；无效正则且无 exact literal 命中时非法。

grep 没有 match mode，也不分类 identifier、long text、natural language 或 relation intent。

## 候选

### 正文命中

所有文件通过一次稳定正文访问执行已解析的 query matcher。合法正则直接执行；非法正则使用完全转义后的 exact literal matcher 探测，但只有整次扫描至少一个直接命中时才接受。受结构分析大小限制保护的代码文件一次读取并解码后保留当前 snapshot 正文，后续 LSP 或 Tree-sitter 直接复用；普通文本和大文件继续流式逐行扫描。命中受支持代码时，选定的结构 analyzer 将同一最小 code unit 中的命中聚合为一个 verified region；无法解析或没有语法归属的命中保持为文本行。

literal fallback 的成功正文在结果开始处显示：

```text
<grep>
warning: invalid regex; exact literal fallback used
src/parser.ts:42: const value = read(input);
</grep>
```

`details.query_mode` 为 `regex` 或 `literal_fallback`；fallback region 的 `matched_by` 为 `literal`、source 为 `text-literal`。

### Symbol 分析与零命中回退

正文扫描期间 grep 并行预热 inventory 涉及的 LSP server；扫描完成后调用一次 LSP analyzer：

1. 有正文命中时，document symbol 将所有命中映射到最小规范代码单元；
2. 零正文命中时，workspace symbol 在本次已成功扫描的代码路径内选择有界候选，再由 document symbol 建立代码单元；
3. incoming calls 和 references 判断每个选中定义是否被其他代码单元调用或引用；
4. analyzer 只通过 grep 提供的 snapshot-bound loader 读取文件；
5. 返回的 `coveredPaths`、文档 hash、分析状态、文件路径和 byte range 必须通过整体校验。

LSP 结果先保存在临时事务中，只有所有目标路径、server、能力和请求全部成功后才一次性提交。任一 server 不可用，任一 document symbol、reference、call hierarchy 或 workspace symbol 请求失败、超时、结果失效，或返回结果未覆盖全部目标路径时，所有 LSP 中间结果都会被丢弃；Tree-sitter 随后复用已经稳定读取的正文完整重跑，不与 LSP 部分结果拼接。协议定义的空 symbol/reference/call 结果是完整结果，不会仅因结果为空而回退。用户取消直接终止，不启动回退。

零命中且没有可用 LSP 结果时，Tree-sitter 使用扫描阶段保存的有界 line anchor；名称、signature、结构 token 和 anchor 达到固定覆盖率后形成 lexical related region。回退不解释 caller、callee、test、fixture、mock、registration 或 entrypoint 等词义；没有合格证据时结果仍可为空。

## 排序

排序只使用候选自身证据和代码关系，不检查或推断 `src`、`tests`、`spec`、fixture、mock 等路径上下文。LSP 可用时，存在外部调用的定义优先于只有外部引用的定义，后者优先于仅被定义的代码单元；因此真正参与功能调用链的代码通常排在只声明、只验证或未被调用的同名代码之前。

稳定比较顺序为：

```text
query tier + authority
-> BM25F field score
-> evidence fusion score
-> verified coverage
-> smaller region
-> path
-> start line
-> end line
-> region id
```

query tier 从强到弱依次覆盖：

1. exact qualified/symbol definition；
2. exact member、symbol prefix、结构化 symbol/path 词项覆盖；
3. verified phrase/text/qualified occurrence/enclosing region；
4. verified text line；
5. high-coverage lexical related；
6. 其他合格 lexical related。

每个 query tier 内再按 `called -> referenced -> defined -> unknown` 分成 authority band。Tree-sitter 只能确认 `defined`；LSP 可通过跨代码单元 incoming call/reference 提升 authority。外部引用必须来自候选自身范围之外，同一声明内部的自引用不计入提升。

同一结构 tier 的 BM25F 字段依次覆盖叶子 symbol、qualified symbol/owner、path、declaration/signature 和命中正文。regex/literal 命中只提供事实准入，不使用文件遍历位置作为相关性 rank。排序不推断 `src` / `tests` 语义，也不按 token 成本重排。

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

verified region 保留完整唯一 `match_lines`；`grep_regional_display_limit` 只限制每个 region 展示的代表行数。declaration 和代表行最多 240 个 Unicode code point。完整源码由 `read(path,start_line,end_line)` 返回。

代码 region 的模型正文只展示 path/range、可选 symbol、无标签 declaration 和代表行；related region 追加 `[not match, related]`。`kind`、`roles`、`matched_by` 和字段名仅保留在 `details` 与内部排序数据中，不重复进入模型文本。未展示的 verified 匹配以 `+N match lines` 标记。

连续的同文件 `kind=text` region 在模型文本和 grep tool widget 展开视图中共享一次文件路径，随后逐行展示。该压缩只发生在 renderer：每行仍是独立候选和独立 region，分别参与排序与选择，不受 `grep_regional_display_limit` 额外限制；`details` 不合并。

relevance 排序后，`grep_related_result_limit` 先静默保留前 N 个 related/semantic region；默认 8，设为 0 可禁用 related results。被该限制过滤的候选不进入模型可见 `total_candidates`、`truncated_by` 或 omitted 提示，verified region 不消耗 related 配额。

剩余候选再受 `grep_result_limit` 限制。候选超过限制时：

- 前 4 条 relevance head 原样保留，其余名额只在同 tier 内用 MMR 选择互补候选；
- `truncated_by` 包含 `result_limit`；
- 开始标签显示 `<grep truncated="result_limit">`；
- 结尾显示省略的低排名候选数量。

grep 不按模型输出 token 数删除、替换或重排结果。`approx_tokens` 仅用于观测。

其他 `truncated_by` 原因只来自上游搜索边界：

- `traversal_limit`。

正文 hit、related anchor、related 静默限额和 AST 增强的内部容量不进入 `truncated_by`。`details.stats` 记录 `text_hits`、`dropped_text_hits`、`dropped_related_anchors`、`dropped_related_results` 和 `ast_skipped_oversized_files`；telemetry 投影使用对应的 `*_count` 字段。

`details.ranking` 只供 telemetry 使用，记录算法标识、related cap 前后候选数、tier、relevance head、MMR 替换、纯 relevance 前缀与最终选择的文件覆盖，以及每条可见 region 的原始 relevance rank、tier、主/辅助分数和选择阶段。模型正文和 TUI region 不显示这些内部评分。

## 文件与解析语义

有正文命中时，LSP analyzer 要求所有目标 server 同时支持 document symbol、references 和 call hierarchy；零正文命中时还要求 workspace symbol。能力必须在执行前全部满足，候选数量和并发有硬上限，并复用现有 LSP deadline。

LSP 无法完整提交时，C/C++、TypeScript、TSX、JavaScript、JSX、Python、Go、Rust、Bash 整体回退 Tree-sitter。语言、扩展名、grammar 来自共享 catalog；新增 catalog 注册项会自动获得 code-index AST adapter，专用语义 adapter 再补充 symbol、import 和 call 提取。未注册语言或解析失败安全退化为文本行。

每次 invocation 使用 host 已绑定的 visibility state；嵌套规则随 inventory 的目录枚举增量加载。inventory 应用 scope、glob、blocked path、soft ignore、深度和 canonical identity 去重。递归不跟随 child symlink。

inventory entry 携带 object identity、version 和 size snapshot。line scan 和 AST read 都要求 snapshot 稳定；文件变化时不保留部分命中。LF、CRLF、CR 和 UTF-8 BOM 使用统一 logical-line 语义，range 使用剥离 BOM 后正文的 UTF-8 byte 坐标。

正文事实扫描不按文件数量、累计字节或单文件字节提前停止。`grep_ast_max_file_bytes` 限制 LSP/Tree-sitter 结构增强和可复用全文缓存；超限文件仍通过流式扫描保留 verified 文本结果。

## 零结果

正文和 related 回退都没有合格候选时：

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
| `INVALID_OPERATION` | query 为空、包含 NUL 或 CR/LF |
| `INVALID_REGEX` | query 不是合法正则，且 exact literal 探测无直接命中 |
| `INVALID_PATH` | path/glob 非法 |
| `PATH_NOT_FOUND` | scope 不存在 |
| `PROTECTED_PATH` | path 被配置阻止 |
| `BINARY_FILE_UNSUPPORTED` | 显式文件是二进制 |
| `ENCODING_UNSUPPORTED` | 显式文件不是有效 UTF-8 |
| `OPERATION_ABORTED` | 调用被取消 |
