# AGENTS.md

## 项目

本仓库是 `~/.pi` 配置目录，用于构建个人 Pi Coding Agent：扩展、工具、命令、skills、prompts 和配置。

用户不负责 TypeScript 实现。Agent 应自行完成分析、修改、重构、验证和文档同步，不把代码工作转交给用户。

## 决策顺序

1. 涉及 Pi API、类型、事件、目录或配置时，先查本地依赖源码和类型；不确定再查官方文档或官方仓库。禁止凭记忆实现。
2. 优先使用 Pi 官方机制：`AGENTS.md` 长期规范，`APPEND_SYSTEM.md` 追加系统提示，`SYSTEM.md` 替换角色，`agent/extensions/` 工具、命令、事件钩子和运行时。
3. Markdown 能解决的，不写 TypeScript 扩展；runtime、schema、tool result 能表达的，不写长期 prompt。

## 实现原则

- 避免过度工程化, 总是采用最直接最简洁的实现方式
- 只实现当前需求所需内容；删除废弃代码、配置、依赖和注释。
- 允许破坏性重构；不保留旧接口、兼容层或“以后可能用”的抽象。
- TypeScript 保持严格类型；避免 `any`、非空断言、双重断言和无意义包装层。
- 函数职责单一；错误在边界处理；异步逻辑处理取消、资源释放和并发写入。
- 面向模型的文本和工具输出必须短、结构清晰、信息充分。
- 模型可见输出的自生成标签、分隔符和映射符使用紧凑 ASCII；文件、网页、进程和用户提供的原始 payload 保留 Unicode；TUI 展示不受此限制。
- 避免巨型单体文件

## 提示词规则

- 最少 token 表达可执行意图；删除背景、寒暄、同义重复和低频示例。
- 同一规则只放一层；上层已定义的不在下层重复。
- 工具名、description、parameter description、promptSnippet、promptGuidelines 均短而无歧义。
- 修改 prompt 后检查重复、冲突、必要性和可下沉到 schema、runtime、tool result 的内容。

## 测试

不要测试不在真实业务逻辑中的代码.

## 语言

使用简体中文与用户交流, 使用简体中文编写代码注释.
