# 文件工具架构

## 依赖

```text
Pi 扩展与前端呈现
  -> 工具适配器
  -> ls/read/write/edit/find/grep
  -> WorkspaceFileSystem
  -> 命名空间、访问策略与文件系统服务
  -> Node I/O
```

六个工具通过 `WorkspaceFileSystem` 访问工作区。文件系统层负责路径、权限、可见性、快照与修改，工具负责参数、算法和结果。

| 路径 | 职责 |
| --- | --- |
| `src/harness/extensions/file-tools.ts` | 注册工具、绑定遥测和延迟加载 |
| `src/harness/file-tools/*/schema.ts` | 参数 schema，参数类型由 schema 推导 |
| `src/harness/file-tools/pi/` | Pi、LSP、技能与媒体适配 |
| `src/harness/file-tools/runtime/` | 主机、版本观测与 Bash 变更作用域 |
| `src/harness/filesystem/contracts/` | 路径引用和能力契约 |
| `src/harness/filesystem/kernel/` | 命名空间、身份和访问策略 |
| `src/harness/filesystem/services/` | 元数据、内容、可见性、发现和修改 |
| `src/harness/filesystem/platform/node/` | I/O 和修改队列 |
| `src/harness/worker-runtime/` | 工作线程生命周期 |

## 调用

1. 适配器打开主机调用。
2. 主机按 `cwd` 加载并校验配置。
3. 文件系统创建命名空间，绑定策略、可见性和取消信号。
4. 工具通过文件系统能力执行操作，按需调用增强端口。
5. 适配器生成 `content`、`details` 和结构化结果。
6. 调用结束后释放租约。

路径引用由命名空间通过对象身份管理。原生路径只在适配边界读取，其他命名空间的引用会被拒绝。

`FileSystemRuntime` 直接持有共享可见性服务、修改队列和关闭信号。每次 `open()` 创建调用级服务与取消控制器，租约释放时取消该调用。运行时关闭时取消全部调用并释放队列和可见性状态。

## 工具端口

- `read` 使用结构、图片和 PDF 端口，缺失路径建议由自身排名。
- `write`、`edit` 直接使用 SDK `generateDiffString`，保留可替换的差异函数和诊断端口。
- `grep` 使用绑定范围与快照的代码分析端口。
- `find` 在路径发现结果上执行本地 fzf 排名。

LSP 通过受控快照加载器取得正文。`read/structure.ts` 决定包围符号与大纲展示，`grep/symbol-analysis.ts` 接纳逐文件结果并决定回退。

## 延迟加载

扩展注册时只加载工具定义和调用边界。首次执行加载对应适配器与主机，同一加载过程由并发调用共享。执行模块加载失败后可重试。

LSP、代码语法、图片和 PDF 按增强路径加载。TUI 呈现器在终端会话启动时加载。

`find` 为无状态函数。`grep` 持有正文缓存、语法缓存和工作线程。语言和 WASM 路径由 `src/harness/syntax-tree/grammars.ts` 统一提供。

## 版本与修改

稳定读取在打开和读取后检查文件身份。原始字节版本写入会话的 `ObservationStore`，成功修改通过提交回调记录新版本。

修改按规范目标在进程内串行。进入队列后重新检查路径策略、符号链接和父目录身份，`edit` 再校验观测版本与当前快照。提交前取消终止写入，提交后诊断失败保留修改成功结果。

`mutations.run()` 返回提交回执和准备结果，返回即表示成功。准备和提交失败通过异常退出，文件工具边界仅转换已知领域错误，模型输出沿用原协议。查询保留 `FsResult`，用于搜索中的局部失败处理。

SDK `withFileMutationQueue` 不提供等待取消和宿主关闭接口，因此此处保留可取消的目标队列。同批次写入共用一个 LSP 加载器，全部提交后按文件合并诊断。

当前会话执行 Bash 时，扩展在命令前后稳定读取已观察文件。开始时版本仍一致的文件可以采纳命令期间的变化。作用域按调用时间归因，无法区分同期其他进程的写入。

## 代码分析

`code-index/parser.ts` 编排单文件分析，各语言提取器识别声明、函数、回调和调用位置。`code-index/structure.ts` 组合 LSP 与语法结构，有效语义范围优先，冲突与歧义保留在结果中。

语法缓存按正文快照保存结构，关系证据由当次 LSP 查询生成。`SourceIndex` 统一转换 UTF-16 与 UTF-8 坐标。解析与 AST 分析共用固定截止时间，解析器和语法树在结束时释放。

## 关闭

扩展先停止新调用，再释放已加载工具，最后关闭主机与文件系统。进程级 LSP 由 LSP 扩展管理，会话切换保留连接，重载和退出关闭连接。
