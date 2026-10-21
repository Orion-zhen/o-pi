# 审批规则

## Bash 分析

Tree-sitter 将 Shell 输入拆为简单命令、嵌套替换、静态 `-c` 子脚本和文件写重定向。每个单元保留原文和解包后的有效命令。一次工具调用汇总为一个审批框，批准后执行完整原命令。

解析器按执行顺序跟踪赋值、工作目录、有限循环取值、静态函数调用和 EXIT trap。Bash 审批与技能路径解析共用引号和转义解码。

语法错误、超时、资源不可用或复杂度超限时，输入作为 `<opaque>` 单元处理。动态命令使用 `<dynamic>`。不透明输入可生成会话规则，无法生成持久规则。

## 临时范围

解析器将有效 `mktemp` 创建的路径和系统临时目录后代视为临时范围。支持静态模板、`-d`、`--suffix`、`--tmpdir` 和 `-p`。

完全位于该范围的重定向、删除、write、edit，以及临时工作区的 `git clean` 和 `git reset --hard` 可跳过 ask。

临时根本身、逃逸路径、混合目标、可能分词的裸变量、`rmdir -p`、提权和无法确定的控制流无法获得豁免。显式 deny 仍优先。

## 事实与动作

`tools.bash.facts` 按事实 ID 定义分类器和可选动作。字符串分类器匹配单条命令原文，对象形式可以指定：

- `scope`：`raw-input`、`source-unit` 或 `effective-unit`。
- `platform`：按当前进程平台限制。

`combinations` 在多个事实同时出现时升级动作，优先级为 deny、ask、default_action。Bash 的默认 deny 拒绝整次调用，记忆规则和临时范围不能覆盖。

用户覆盖按 ID 递归合并。分类器和组合可设为 false，事实可设 `enabled: false`。配置加载时校验正则和事实引用。

## 路径规则

```json
{
  "name": "system-path-write",
  "tools": ["bash", "write", "edit"],
  "path_globs": ["/etc/**", "/usr/**", "/System/**"],
  "reason": "system path modification"
}
```

规则匹配 write、edit 目标和可静态解析的写重定向。普通命令参数如 `rm /etc/file` 由 Bash 分类器处理。

目标转为使用 `/` 的绝对路径，技能保留 `skill://`。glob 使用 picomatch，`*` 匹配一个路径段，`**` 跨段，数组任一命中即可。缺少 `path_globs` 时只匹配工具名。

## 记忆规则

默认规则文件为 `~/.pi/agent/state/approval-gate.rules.jsonc`。

- `exact_command`、`command_prefix` 必须包含 cwd。
- `exact_path`、`path_glob` 只按路径匹配。
- 私网规则按完整 origin 匹配。

安装命令可以生成保守前缀，如 `npm install`。推送等操作保存完整命令。路径只在明确范围内生成 glob，其余保存精确值。

```json
{
  "rules": [{
    "tool": "bash",
    "kind": "exact_command",
    "value": "git push origin main",
    "cwd": "/workspace/project"
  }]
}
```

GUI 对相同规则文件共享加载与写入队列，临时授权按逻辑会话隔离。执行实例回收保留临时授权，新的会话和分支不继承，宿主退出后失效。

判定前检查外部文件变化。写入串行并原子替换，保存失败保留原内存规则。读取损坏规则文件时阻止执行。跨进程同时写入仍可能互相覆盖。
