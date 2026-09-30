# 测试

规范见根目录 `AGENTS.md`。测试运行器为 Vitest，需要 Node.js >= 22.19.0，产品和构建使用 Bun。

## 目录

- `harness/`：业务模块与 SDK 工具流程。底层单元测试只补充集成测试难以确定复现的竞态、协议和资源边界。
- `tui/`：对应 `src/tui/` 的 `shell`、`editor`、`chat`、`views`、`terminal` 和 `components`。
- `cli/`、`rpc/`：真实入口与工具回路。
- `gui/`：共享宿主、界面行为和 Playwright 端到端测试。
- `helpers/`：跨模块共用的测试辅助代码。模块专属夹具随测试存放。

跨层集成测试按主要业务归属存放，不为目录对齐拆分用例。相同场景不在每层重复验证。不锁定内部对象身份、工厂调用次数、界面文案、错误句子或生成提示词原文。参数错误验证拒绝行为或错误码。文件正文、协议字段、路径和安全转义仍验证实际数据。

遥测测试使用真实 JSONL 文件，SDK 测试验证工具投影与正文不落盘。文件修改测试保留符号链接、并发覆盖、取消、字节限制和句柄释放场景。

## 运行

- `bun run test`：先构建二进制，再执行完整测试。
- `bun run test tests/cli tests/rpc`：验证真实二进制、子代理、RPC 和终端启动。
- `bun run typecheck`：检查源码与测试类型，不生成 JavaScript。
- `bun run test --coverage`：执行覆盖率检查。
- `bun run vitest run tests/harness tests/tui`：直接运行业务和界面测试，不重新构建。
- `bun run test:gui`：先构建 Web 和桌面版，再执行 Playwright 端到端测试。

Vitest 使用 mock 隔离系统通知。GUI 端到端测试为桌面和 Web 子进程设置 `OPI_NO_NOTIFICATIONS=1`，关闭系统通知但保留审批交互。该开关仅在值为 `1` 时生效，修改通知代码后必须重新构建测试产物。

CLI 的模型边界使用本地 HTTP 服务，不通过外部扩展注入，不访问付费模型。Vitest 的 Node worker 使用测试目录中的 TS 引导器，产品不携带这个引导器。

容器验证默认跳过。设置 `OPI_CONTAINER_IMAGE` 后会用 Podman 启动不含 Node/Bun 的 Linux 镜像，只挂载临时目录，验证二进制独立运行。参见 [CLI](../docs/cli.md)。
