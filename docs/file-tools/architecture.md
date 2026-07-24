# 架构与生命周期

本文说明文件工具如何注册、加载和组合。面向日常使用的行为摘要见 [文件工具设计](README.md)。

## 扩展入口与实现

- `agent/extensions/file-tools.ts`：注册 `ls` / `find` / `grep` / `read` / `write` / `edit`，定义 schema、renderer 和 prompt metadata。
- `agent/extensions/block-builtin-tools.ts`：屏蔽 Pi 内置工具，保留扩展和 SDK 工具。
- `agent/configs/file-tools.jsonc`：用户级默认配置。
- `agent/schemas/file-tools.schema.json`：配置 schema。
- `src/file-tools/`：路径解析、目录枚举、文本读取、写入和 exact replacement。
- `src/file-tools/ignore/`：统一 ignore engine、snapshot、explain 和 Git tracked set。
- `src/safety/path-guard.ts`：共享的 blocked path lexical / realpath 检查。
- `src/lsp/`：可选 LSP 后端，为部分文件工具附加 symbol、outline 和 diagnostics。

扩展入口与具体实现分离。扩展注册阶段只保留 Pi 所需的 schema、轻量 renderer 和事件；文件遍历、媒体识别、Tree-sitter grammar、LSP runtime 和 Repo Map runtime 不进入同步导入链。

## 工具适配器

六个工具各自拥有独立 adapter。首次调用时只等待对应实现模块：

```text
ls     → 目录枚举
find   → 路径扫描和路径召回
grep   → 文本 / Tree-sitter / LSP / Repo Map 搜索
read   → UTF-8 / 图片读取和版本记录
write  → 文件创建或完整覆盖
edit   → read-before-edit 和 exact replacement
```

同一模块的并发调用共享一个 loading Promise，不会重复加载。模块加载失败后会清除 Promise，后续调用可以重试。

## 可选增强

LSP 只在以下路径真正需要时加载：

- partial 或 truncated `read` 的 symbol context；
- symbol grep；
- `write` / `edit` 后的 diagnostics。

Repo Map 未激活时只检查轻量 session entry；激活后，首次查询或 mutation 才加载 query、storage 和 token formatter。

LSP 失败、超时、未配置或 language server binary 不存在时，工具静默退化为原行为。`ls` 和 `find` 不接入 LSP。Repo Map 候选也必须经过实时内容和 scope 校验，过期候选不会伪装成主结果。

## 生命周期保证

- 交互启动和不使用文件工具的任务不承担重模块加载成本。
- 首次工具调用只支付自身实现及实际启用增强的成本。
- 一个消费者取消时，不会中断仍有其他消费者的共享构建。
- mutation 后，相关缓存和 Repo Map 会在后续调用中按 fingerprint 或 generation freshness 更新。

性能测量和冷/热路径见 [性能与 benchmark](performance.md)。
