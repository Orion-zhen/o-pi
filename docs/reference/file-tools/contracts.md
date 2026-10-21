# 文件工具契约

六个文件工具共用路径、版本、错误和输出约定。具体参数见[模块首页](README.md)。

## 输入

ls、read、write、edit 接受单路径，find、grep 的 path 为非空数组，多个范围取并集。相对路径基于当前调用的 cwd。

find 的 query 使用 fzf 语法，glob 独立筛选候选。grep 默认使用区分大小写的 ECMAScript 逐行正则，也可指定 literal。非法正则返回 `INVALID_REGEX`。

配置在访问工作区前加载，失败返回 `CONFIG_ERROR`。

## 文件系统

`WorkspaceFileSystem` 提供 paths、metadata、content、visibility、discovery 和 mutations。路径解析返回命名空间所属的引用，后续操作使用该引用。

发现服务统一处理范围、glob、可见性、深度和符号链接。内容读取可指定 expectedSnapshot，并在读完后复查文件身份。快照变化映射为 changed-during-read。

## 输出

模型接收紧凑文本或图片，宿主数据保存在 details。自生成标签使用 ASCII，文件、源码和诊断保留原始 Unicode。

模型文本展示影响后续操作的状态，如忽略标记、截断、续读和诊断。指纹、完整差异及内部统计保存在 details。

| 工具 | 输出限制 |
| --- | --- |
| ls | 直属成员数 |
| read | 文本行数、字节数和 PDF 页数 |
| find | 遍历量、深度、结果数和文本词元预算 |
| grep | 遍历量、正文字节、深度、相关结果和总区域数 |

read 的所有区间共享预算，continuation.lines 和 continuation.pages 可直接用于续读。

find.truncated_by 包括 depth_limit、entry_limit、result_limit、output_limit。grep 包括 depth_limit、entry_limit、byte_limit、result_limit。grep 的结构增强与相关结果内部容量保存在统计中。

计数方法见[词元估算](../statistics/token-counter.md)。

## 错误

```xml
<error>
File does not exist.
next: Related paths: src/main.ts
</error>
```

完整 code、path 和 details 保存在结构化结果。合法零结果是成功状态，其他失败使用对应错误码。有恢复动作时附 next。

edit 可以一次报告多个验证错误，恢复候选共用预算。候选用于修改参数后重试，实际执行仍按精确匹配。

## 版本与提交

read 记录原始字节版本，成功 write 和 edit 记录新版本。符号链接与真实目标共享规范身份。Bash 可以采纳命令期间已观察文件的变化。

修改在进程内按规范目标串行，edit 校验内容哈希。提交前取消终止写入，提交后诊断失败保留成功状态。跨进程写入需要调用方协调。

实现与资源释放见[架构](architecture.md)，工具提示词字段见[提示词](../prompts/README.md)。
