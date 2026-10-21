# write

创建或完整覆盖 UTF-8 文件，自动创建缺失的父目录。

## 参数

```json
{
  "path": "src/new-file.ts",
  "content": "export const value = 1;\n"
}
```

path 可为相对或绝对路径。已有文件会完整覆盖，无需预先读取。

## 提交

修改在规范目标队列中串行执行，重新检查目标字面路径、真实路径和最近的现有父目录。悬空符号链接按目标位置解析。

原文件快照和提交内容受 write_max_file_bytes 限制。提交使用同目录临时文件和原子重命名，成功后记录会话版本，可继续 edit。

提交前取消终止写入。失败后已创建的父目录可能保留，清理失败时临时文件也可能保留。跨进程写入需调用方协调。

## 结果

```xml
<write path="src/a.ts"/>
```

差异保存在 details.diff，界面展开后展示。修改后取得诊断时，错误优先，同级新增问题优先，原有问题标记 existing。未知基线保留不确定标记。

可用时附加唯一单文件 quickfix 标题，以及最多三个关联文件的错误。诊断与当前文件共用条数预算。没有可见诊断时返回普通成功结果，诊断失败或超时保留成功状态。

## 错误

| 错误码 | 含义 |
| --- | --- |
| INVALID_OPERATION | 参数结构或类型错误 |
| INVALID_PATH | 目标或父目录无法解析 |
| PROTECTED_PATH | 受阻路径 |
| ACCESS_DENIED | 无写权限 |
| OUTPUT_LIMIT_EXCEEDED | 超过文件字节限制 |
| OPERATION_ABORTED | 调用取消 |
| CONFIG_ERROR | 配置错误 |

公共规则见[工具契约](contracts.md)，诊断机制见 [LSP](../lsp/protocol.md)。
