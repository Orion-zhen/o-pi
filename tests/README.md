# 测试

编写与组织规范见仓库根目录 `AGENTS.md` 的“测试”章节。验证命令：

- `npm test`：先构建 `opi`，再执行完整测试。
- `npm test -- tests/cli`：真实 CLI、RPC、子代理和终端启动测试。
- `npm run typecheck`：测试和源码类型检查。
- `npm run test:coverage`：覆盖 `src/`，并执行全局覆盖率底线。
