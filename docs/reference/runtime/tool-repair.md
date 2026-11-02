# 工具参数修复

参数修复在工具定义的 `prepareArguments()` 中运行，先于 SDK schema 校验和执行。

## 流程

```text
原始参数
-> 已符合 schema 则跳过修复，否则执行定向结构修复
-> SDK 规范化
-> SDK schema 校验与执行
```

参数已经合法时直接返回，避免改写合法路径或正文。修复层不判断最终合法性，也不回退修复结果。数值转换、可选字段的 null 清理和最终校验由 SDK 统一处理。

## 规则

从 schema 推导的修复包括 JSON 数组字符串转数组，以及对象数组字段的单对象包装。

工具可增加少量提示：

| 提示 | 用途 |
| --- | --- |
| `singleStringField` | 将单字符串放入指定字段 |
| `pathFields` | 清理路径开头的 `@` |
| `pathListFields` | 将搜索路径字符串转换为数组 |
| `aliases`、`nestedAliases` | 根字段与嵌套字段别名 |
| `objectArrayFromFields` | 将根字段组合为对象数组 |

路径列表最多 32 项，支持逗号、空白和换行分隔，单引号与双引号保护路径中的空白和逗号。解析失败或超限时保留原参数。

例如：

```json
{ "path": "a.ts", "oldText": "x", "newText": "y" }
```

可修复为：

```json
{ "path": "a.ts", "edits": [{ "old": "x", "new": "y" }] }
```

文件正文、替换文本、命令和查询保持原值，修复只处理已声明的结构与别名。

## 注册与遥测

`src/harness/extensions.ts` 在同一个 factory 内创建工具和遥测服务。`src/harness/register-tool.ts` 直接绑定服务，为工具组合严格采样、修复和遥测，不使用注册广播或就绪握手。默认采样为 `constrainedSampling: { type: "json_schema", strict: "prefer" }`，工具可覆盖。

修复观察器只报告是否改写、操作和路径列表数量摘要。`accepted` 表示未做扩展修复，`repaired` 表示执行了扩展修复，均不表示已通过 SDK 校验。原始参数不由修复层落盘。工具执行计时沿用 SDK。

实现位于 `src/harness/tool-repair/`：`repair.ts` 编排流程，`specs.ts` 推导规则，`types.ts` 定义提示与观察事件。TypeBox `Check()` 仅用于跳过已合法参数的修复。
