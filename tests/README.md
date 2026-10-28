# 测试

运行命令、环境要求和各类测试的范围见[测试 Reference](../docs/reference/runtime/testing.md)。仓库测试规则见 [AGENTS.md](../AGENTS.md)。

测试按主要验证对象对应 `src/` 的模块目录。GUI 前端继续按 `app/`、`features/`、`forms/`、`ui/` 等划分，宿主测试按 `host/` 的子模块划分。Web 和 Electron 测试分别位于 `web/`、`desktop/`，构建验证位于 `build/`。

同一功能的单元测试与 E2E 就近放置，通过 `.test.ts`、`.test.tsx`、`.e2e.ts` 等后缀区分。模块专属夹具与测试放在一起，GUI 内共享夹具位于 `gui/helpers/`，跨模块通用辅助代码位于 `helpers/`。跨模块流程按主要验证对象归类，不为没有测试的源码目录创建空目录。
