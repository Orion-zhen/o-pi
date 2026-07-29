# 配置分层

`agent/defaults/*.jsonc` 是随 o-pi 发布并由 Git 跟踪的完整默认配置。用户配置和项目配置只需写需要覆盖的字段。

加载优先级从低到高为：

```text
~/.pi/agent/defaults/<name>.jsonc
~/.pi/agent/configs/<name>.jsonc
<project>/.pi/configs/<name>.jsonc
```

默认层是唯一的默认值来源，必须存在、包含 schema 中的全部固定字段并通过校验；代码中不保留配置回退常量。用户层和项目层可以不存在。任一已存在层包含非法 JSONC、未知字段、错误类型或无效语义时，配置加载直接失败，不会静默回退。

普通对象递归合并，标量和数组由高优先级层整体替换。模块可以施加更严格的合并规则：File Tools 的项目路径规则只能追加，Subagent 项目配置只能修改普通运行参数，LSP 的项目 `servers` 按 server ID 合并。

## 配置范围

允许项目配置的模块只有：

- `file-tools`
- `lsp`
- `subagent`

`approval-gate`、`bash-tool`、`tui` 和 `web-tools` 只读取默认层和用户全局层；项目中的同名文件不会被读取。

环境变量 `PI_*_CONFIG` 只重定向用户层，不替换默认层。支持项目配置的模块继续使用各自的 `PI_*_PROJECT_CONFIG` 和 `PI_*_PROJECT_ROOT`。默认层固定来自当前 o-pi 安装目录。

## Git 和升级

`~/.pi/agent/configs/` 整体被 o-pi 仓库忽略，用户修改不会产生 o-pi 的 Git 变更。项目的 `.pi/configs/` 是否纳入版本控制由该项目自行决定。

从旧目录布局升级且修改过 tracked `agent/configs/*.jsonc` 时，应在拉取前先备份这些文件；升级后将需要保留的差异作为稀疏覆盖放回新的 `agent/configs/`。不要复制整份默认配置，否则以后新增默认字段时不易判断哪些值是用户有意覆盖。
