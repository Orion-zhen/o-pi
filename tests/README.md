# 测试

规范见根目录 `AGENTS.md`。测试运行器为 Vitest，需要 Node.js >= 22.19.0，产品和构建使用 Bun。

## 目录

- `harness/`：对应 `src/harness/` 的业务模块与 SDK 扩展，扩展装配测试集中在 `harness/extensions/`。
- `tui/`：对应 `src/tui/` 的 `shell`、`editor`、`chat`、`views`、`terminal` 和 `components`。
- `cli/`、`rpc/`、`architecture/`、`benchmark/`：入口、跨模块约束与基准测试。
- `helpers/`：跨模块共用的测试辅助代码。模块专属夹具随测试存放。

跨层集成测试按主要业务归属存放，不为目录对齐拆分用例。

## 运行

- `bun run test`：先构建二进制，再执行完整测试。
- `bun run test tests/cli tests/rpc`：验证真实二进制、子代理、RPC 和终端启动。
- `bun run typecheck`：检查源码与测试类型，不生成 JavaScript。
- `bun run test --coverage`：执行覆盖率检查。
- `bun run vitest run tests/harness tests/tui`：直接运行业务和界面测试，不重新构建。

CLI 的模型边界使用本地 HTTP 服务，不通过外部扩展注入，不访问付费模型。Vitest 的 Node worker 使用测试目录中的 TS 引导器，产品不携带这个引导器。

容器验证默认跳过。设置 `OPI_CONTAINER_IMAGE` 后会用 Podman 启动不含 Node/Bun 的 Linux 镜像，只挂载临时目录，验证二进制独立运行。参见 [CLI](../docs/cli.md)。
