# AGENTS.md

## 项目

本仓库是 `~/.pi` 配置目录，用于构建个人 Pi Coding Agent：扩展、工具、命令、skills、prompts 和配置。

用户不负责 TypeScript 实现。Agent 应自行完成分析、修改、重构、验证和文档同步，不把代码工作转交给用户。

## 决策顺序

1. 涉及 Pi API、类型、事件、目录或配置时，先查本地依赖源码和类型；不确定再查官方文档或官方仓库。禁止凭记忆实现。
2. 优先使用 Pi 官方机制：`AGENTS.md` 长期规范，`APPEND_SYSTEM.md` 追加系统提示，`SYSTEM.md` 替换角色，`agent/extensions/` 工具、命令、事件钩子和运行时。
3. Markdown 能解决的，不写 TypeScript 扩展；runtime、schema、tool result 能表达的，不写长期 prompt。

## 实现原则

- 只实现当前需求所需内容；删除废弃代码、配置、依赖和注释。
- 允许破坏性重构；不保留旧接口、兼容层或“以后可能用”的抽象。
- TypeScript 保持严格类型；避免 `any`、非空断言、双重断言和无意义包装层。
- 函数职责单一；错误在边界处理；异步逻辑处理取消、资源释放和并发写入。
- 面向模型的文本和工具输出必须短、结构清晰、信息充分。
- 模型可见输出的自生成标签、分隔符和映射符使用紧凑 ASCII；文件、网页、进程和用户提供的原始 payload 保留 Unicode；TUI 展示不受此限制。

## 提示词规则

- 最少 token 表达可执行意图；删除背景、寒暄、同义重复和低频示例。
- 同一规则只放一层；上层已定义的不在下层重复。
- 工具名、description、parameter description、promptSnippet、promptGuidelines 均短而无歧义。
- 修改 prompt 后检查重复、冲突、必要性和可下沉到 schema、runtime、tool result 的内容。

## 工作流程

- 修改前阅读结构、`package.json`、相关配置、源码和本地 Pi 类型。
- 修改中同步调用点、类型、配置、测试和文档；不改无关行为。
- 修改后检查 diff，删除调试内容，运行可用的 typecheck、test 或冒烟验证，并说明未验证项。

## 测试

- 测试放 `tests/<module>/`；同一公开执行链的 schema、runtime、扩展适配和回归用例放在同一文件，仅在夹具或进程隔离确有差异时拆分。
- 合并仅输入与期望不同的重复用例为 `it.each` 表驱动；共享准备逻辑提取为小型测试夹具，不复制 setup、mock 或断言流程。
- 临时目录和环境变量使用 `tests/helpers/lifecycle.ts`；HTTP 响应使用 `tests/helpers/http.ts`。用例必须相互独立，并清理文件、环境变量、timer、mock、子进程、server、dispatcher 和 runtime。
- 优先覆盖 Pi 适配、schema、安全边界、错误结构、缓存、并发、取消、资源释放和关键上下文流；bug 修复须在最低稳定边界增加回归用例。
- Mock 只隔离网络、进程、时间和 Pi host 等边界；不复制被测实现，不访问真实外部服务，不用任意 sleep 等待异步结果。
- 断言稳定的公开行为和结构化字段，不依赖实现细节。prompt 的正文、标签、顺序和措辞不属于测试契约，只允许覆盖构建不崩溃、运行时错误、安全与副作用边界；UI 不断言文案、图标、颜色或具体布局，只验证交互、清理、宽度和信息不丢失等稳定行为。
- 测试 TypeScript 遵守源码的严格类型规则；平台差异用最小 `skipIf` 或分支断言表达，不静默降低通用覆盖。
- 修改后运行 `npm run typecheck`、`npm test` 和 `npm run test:coverage`。不得降低覆盖率门槛、扩大排除范围或删除有效断言来规避失败。
