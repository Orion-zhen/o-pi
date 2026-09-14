# 测试

规范见根目录 `AGENTS.md`。测试运行器为 Vitest，需要 Node.js >= 22.19.0，产品和构建使用 Bun。

- `bun run test`：先构建二进制，再执行完整测试。
- `bun run test tests/cli tests/rpc`：验证真实二进制、子代理、RPC 和终端启动。
- `bun run typecheck`：检查源码与测试类型，不生成 JavaScript。
- `bun run test --coverage`：执行覆盖率检查。
- `bun run vitest run tests/<目录>`：直接运行源码测试，不重新构建。

CLI 的模型边界使用本地 HTTP 服务，不通过外部扩展注入，不访问付费模型。Vitest 的 Node worker 使用测试目录中的 TS 引导器，产品不携带这个引导器。

容器验证默认跳过。设置 `OPI_CONTAINER_IMAGE` 后会用 Podman 启动不含 Node/Bun 的 Linux 镜像，只挂载临时目录，验证二进制独立运行。参见 [CLI](../docs/cli.md)。
