# Tool Input Repair

`tool-repair` 是工具注册边界的轻量参数修复层，用于提升本地和开源模型的工具调用稳定性。它只负责纯参数修复；可选 observer 会报告参数状态和 repair operation，但不负责持久化或执行计时。

它不增加模型可见工具，不放宽公开 schema，也不把兼容逻辑散落到各个工具的 `execute` 中。所有修复都挂在工具定义的 `prepareArguments(args)` 上，在 Pi schema validation 和 execute 前运行。

## 边界

执行顺序：

```text
raw args
  -> original prepareArguments
  -> TypeBox schema check
  -> targeted repair
  -> TypeBox schema check
  -> valid repaired args 或 original prepared args
```

如果原始 `prepareArguments` 结果已经合法，repair 不做任何修改。只有修复后的对象能通过原工具 schema 校验时，才返回修复结果。修复失败时返回原始 prepared 参数，让 Pi 按原流程 validation fail，避免半修复对象进入 `execute`。

不使用 `tool_call` hook 作为主 repair 层。`tool_call` 修改 input 后不会重新走 schema validation，无法保证修复结果满足工具 schema。

## 模块

源码位于：

```text
src/tool-repair/
  index.ts
  repair.ts
  specs.ts
  types.ts
```

职责：

* `repair.ts`：实现 `repairableTool()` 包装器、修复流程和最终校验。
* `specs.ts`：从 TypeBox schema 推导可机械修复的字段。
* `types.ts`：定义 repair spec、工具侧 hints 和通用 observer 事实。
* `index.ts`：导出公共入口。

## Schema 推导

repair spec 主要从工具的 TypeBox schema 推导，工具侧只补 schema 无法表达的 hints。

自动推导：

* `type: "number"` / `type: "integer"` -> `numericFields`
  * 允许数字字符串转数字，例如 `"20"` -> `20`。
* `type: "array"` -> `arrayFields`
  * 允许 JSON 字符串数组转数组，例如 `"[...]"` -> `[...]`。
* `type: "array"` 且 `items.type === "object"` -> `objectToArrayFields`
  * 允许单对象转单元素数组，例如 `{...}` -> `[{...}]`。
* object 的 `properties` 和 `required`
  * 不在 `required` 中的字段推导为 `optionalFields`，允许 optional 字段为 `null` 时删除。
* 嵌套字段使用点路径表示
  * 例如 `tasks.*.cwd`、`edits.*.oldText`。

schema 不能表达的 hints：

* `singleStringField`：单字符串调用对象工具时落到哪个字段，例如 `read` -> `path`，`bash` -> `command`。
* `pathFields`：哪些路径字段允许去掉开头 `@`。
* `pathListFields`：哪些路径字段允许把旧字符串迁移为路径数组；只应配置在搜索工具的路径字段上。
* `maxPathCount`：路径列表 repair 的最大路径数量，默认 32；超限输入不猜测、不提交。
* `aliases`：根字段别名迁移，例如 `startLine` -> `start_line`。
* `nestedAliases`：嵌套字段别名迁移，例如 `edits.*.oldText` -> `old`。
* `objectArrayFromFields`：从根字段组合对象数组，例如 `{ old, new }` -> `{ edits: [{ old, new }] }`。

推导只决定“可以尝试哪些机械结构修复”。能否提交结果始终由原工具 schema 决定。

## V1 修复规则

V1 只做机械结构修复：

* 删除 optional 字段上的 `null`。
* 数字字段字符串转数字。
* 数组字段 JSON 字符串转数组。
* 对象数组字段单对象转数组。
* 单字符串转对象字段。
* 路径字段去掉开头 `@`。
* 搜索路径字段的旧单字符串迁移为单元素数组（`scalar_to_array`）。
* 搜索路径字段的逗号、空白或换行分隔字符串迁移为路径数组（`split_path_list`）；支持单引号和双引号保护空白或逗号。
* 字符串迁移后去重，并逐项执行路径前缀清理；空 token、无法解析和超出最大数量时保留原参数并让 schema 校验失败。
* 字段别名迁移。
* 删除 unknown fields，但只提交最终能通过 schema validation 的结果。

特殊支持 `edit` 常见结构错误：

```json
{
  "path": "a.ts",
  "oldText": "x",
  "newText": "y"
}
```

修成：

```json
{
  "path": "a.ts",
  "edits": [{ "old": "x", "new": "y" }]
}
```

同样支持 `edits` 传 JSON 字符串或单对象。

## 明确不做

repair 层不做语义推断：

* 不 trim 或 parse `write.content`。
* 不 trim、parse 或改写 `edit.old` / `edit.new`。
* 不改写 `bash.command`。
* 不自动猜测 `file`、`path`、`query`、`content` 之间的语义。
* 不给 URL 补 `https://`。
* 不拆分未配置为 `pathListFields` 的普通字符串，尤其是 `query`、`content`、`old` 和 `new`；也不为 `read`、`write`、`edit` 启用批量路径执行。
* 不扩大 schema，不新增模型可见参数。

这些约束保证 repair 只处理结构错误，不改变模型明确给出的文本、命令、补丁内容或访问目标。

## 接入工具

当前接入点：

* `agent/extensions/file-tools.ts`
  * `ls`、`find`、`grep`、`read`、`write`、`edit`
* `agent/extensions/bash-tool.ts`
  * `bash`
* `agent/extensions/web-tools.ts`
  * `websearch`、`webfetch`
* `agent/extensions/subagent.ts`
  * `subagent`

仓库内的模型工具通过统一注册入口组合 repair 和 telemetry。`registerObservedTool` 将 repair observer 直接连接到当前 Pi 的 `TelemetryService`；只有状态和 operation 会合并进内存中的 pending call，原始和修复后参数不会由 repair observer 落盘，工具 execute 不会被 telemetry 包裹：

```ts
registerObservedTool(pi, {
  tool: {
    name: "read",
    parameters: readParameters,
    async execute(...) {
      // ...
    },
  },
  repair: {
    singleStringField: "path",
    pathFields: ["path"],
    aliases: {
      startLine: "start_line",
      endLine: "end_line",
    },
  },
  telemetry: readTelemetry,
});
```

工具自身已有 `prepareArguments` 时，wrapper 会先调用原函数，再执行 repair。

## 校验

repair 层使用本地 TypeBox `Check(schema, value)` 校验原 schema，不维护自定义 validator。测试覆盖：

* 原 `prepareArguments` 之后再 repair。
* repair 成功才返回修复结果。
* repair 失败返回原始 prepared 对象。
* `edit` 不改写 `old/new` 内容。
* 实际扩展注册的工具都挂载了 `prepareArguments`。
* 搜索路径数组的单字符串、分隔字符串、引号保护、`@` 前缀和失败边界。
