# 架构与生命周期

本文说明文件工具的最终依赖方向、运行时组合和资源 owner。日常行为摘要见 [文件工具设计](README.md)。

## 分层与依赖方向

```text
agent/extensions/file-tools.ts
        |
        v
Pi schemas / adapters / renderers / telemetry
        |                    ^
        | tool-local ports   | LSP / skill / image / diff adapters
        v                    |
ls  read  write  edit  find  grep
        |
        v
WorkspaceFileSystem contracts
        |
        v
namespace/access kernel + filesystem services
        |
        v
Node platform backend
```

主要目录：

- `agent/extensions/file-tools.ts`：注册 schema、prompt metadata、telemetry、lazy adapter 和 TUI renderer。
- `src/file-tools/{ls,read,write,edit,find,grep}/`：各工具自己的参数、结果、command、presenter、纯算法和 port。
- `src/file-tools/pi/`：把 Pi、LSP、skill、图片和 diff 能力映射为消费者拥有的 port DTO。
- `src/file-tools/runtime/`：`FileToolsHost` 与 session `ObservationStore`。
- `src/file-tools/shared/`：无 I/O 的错误、diagnostics、diff 和 ranking 叶子 contract。
- `src/file-tools-config/`、`src/file-tool-limits.ts`：配置 control plane 与工具预算。
- `src/filesystem/contracts/`：opaque path ref 和 capability contract。
- `src/filesystem/kernel/`：namespace、lexical/canonical identity 与 access policy。
- `src/filesystem/services/`：metadata、visibility、content、traversal、catalog 和 mutation。
- `src/filesystem/platform/node/`：Node I/O primitive 与进程内 mutation queue。
- `src/worker-runtime/`：grep 等 CPU/进程任务可复用的 worker 生命周期基础设施。

六个工具互不导入，也不直接导入 `node:fs`、`node:path`、配置 loader、ignore 实现、path guard 或 LSP。所有 workspace metadata、枚举、读取、遍历和 mutation 都经 `WorkspaceFileSystem`；architecture test 对这条边界进行无 legacy allowlist 的静态检查。filesystem 层不导入 file-tools、Pi、LSP、skill 或 code-index。

## Invocation composition

每个 Pi 调用执行：

1. adapter 使用 `ctx.cwd`、session id 和 `AbortSignal` 调用 `FileToolsHost.open`；
2. host 在任何 workspace I/O 前加载并校验该 cwd 的用户/项目配置；
3. `FileSystemRuntime` 创建 namespace，并绑定不可变 filesystem policy 与 visibility snapshot；
4. host 返回 `WorkspaceFileSystem`、只读 limits、session observation、operation context 和仅供 composition adapter 使用的 native bridge；
5. command 只组合 filesystem capability、自身算法和自己的可选 port；
6. adapter 格式化 Pi content/details，最后释放 invocation lease。

opaque `FileRef`、`DirectoryRef` 和 `TargetRef` 保存逻辑身份；command 不能取回 native path。native bridge 只用于 LSP adapter 映射；LSP 只能通过 command 提供的 snapshot-bound loader 读取 allowed inventory 中的正文。

## Tool-local ports

port 由消费者工具声明，而不是由外部子系统或 filesystem 声明：

- read：缺失路径、structure/graph context、inline image；skill locator 在 adapter 边界预处理；
- write/edit：diagnostics、mutation observer、共享 text diff contract；
- grep：workspace-bound `CodeAnalyzer`；LSP 不反向导入 grep 实现，统一返回规范代码单元和 `called` / `referenced` / `defined` authority。

port 输入输出使用消费者需要的 DTO 和 opaque ref。所有调用都有 safe wrapper；未配置、在 symbol 选择前失败或超时时保留基础行为。find 没有外部增强 port，只对 filesystem discovery 返回的 scope-relative path 执行本地 fzf 排名；grep analyzer 只能读取本次 scope/glob inventory 中的稳定 snapshot。一旦 analyzer 选中 symbol，本次调用采用其完整或部分结果，不再混入逐 symbol 的 Tree-sitter fallback。外部结果不能绕过 filesystem 数据平面。

## Lazy loading

注册阶段只加载 schema、guards、telemetry 和 lazy controller，不加载 filesystem host、各工具 command、native renderer 或增强 runtime。同一模块的并发调用共享 retryable Promise；加载失败会清除 Promise，后续调用可重试。

- 首次调用只动态导入对应 adapter 和 host；
- find/grep 的 stateful tool instance 只在对应 adapter 首次加载时创建；
- TUI renderer 只在 `session_start` 且 mode 为 `tui` 时加载，RPC 不加载；
- LSP manager 只在实际 port 路径需要时加载；
- mutation service/queue 在第一次 write/edit 时加载，readonly 调用不预热它；
- Tree-sitter grammar 和 worker 只在 grep 索引路径实际需要时加载。

## Owner 与释放顺序

| owner | 持有状态 | dispose 行为 |
| --- | --- | --- |
| extension | 已加载 find/grep adapter、lazy LSP、host | shutdown 先停止新调用，再只释放已加载对象 |
| `FileToolsHost` | config provider、filesystem runtime、session observations、invocation leases | 幂等停止/释放；不会触发未加载工具或增强 |
| `FileSystemRuntime` | Node backend、visibility cache、lazy mutation queue、workspace leases | abort leases、释放 queue、invalidate visibility |
| invocation lease | policy/snapshot-bound filesystem 与组合 bridge attachment | abort 本 invocation 并 detach observation bridge |
| `ObservationStore` | canonical identity 到 content version 的 session map | session/host 结束时 clear |
| `FindTool` | tool owner signal | abort pending discovery/ranking |
| `GrepTool` | 派生 AST cache、parser/worker 与 active invocation | abort pending work 并 dispose parser/worker/cache owner |
| lazy LSP port | 本会话的模块加载 Promise | 随 extension 释放，不拥有进程级 manager |

file-tools shutdown 顺序是：拒绝新 invocation，dispose 已加载 tool instances，最后 dispose host/filesystem。进程级 LSP 生命周期只由 LSP extension 管理；`/new`、fork 和 resume 保留 manager，reload 和 quit 才关闭连接。所有 `dispose` 幂等。

## 取消与 mutation 边界

host 将 extension signal、runtime shutdown signal、lease signal 和 tool owner signal组合进 operation context。取消在排队、遍历、读取、line stream、worker/parser、共享 build consumer 和提交前检查点生效；iterator、handle、worker 和 waiter 在结束时释放。

mutation 按 canonical target 在同进程串行。安全策略和 symlink/parent identity 在 queue 内重新检查，edit 同时校验当前 snapshot hash。提交是不可回滚边界：成功写盘后 observation 已由 filesystem commit callback 更新，后置 diff 之外的 LSP 失败或取消不能把成功 mutation 改成失败。

性能测量与缓存细节见 [性能与 benchmark](performance.md)。
