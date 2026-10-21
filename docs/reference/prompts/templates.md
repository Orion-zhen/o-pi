# 提示词模板

模板是可通过斜杠命令展开的 Markdown。文件名决定命令名，例如 `review.md` 对应 `/review`。

## 发现

| 范围 | 路径 |
| --- | --- |
| Pi 用户 | `~/.pi/agent/prompts/*.md` |
| Pi 项目 | `.pi/prompts/*.md` |
| 用户补充 | `~/.agents/prompts/*.md` |
| 项目补充 | 当前目录及祖先的 `.agents/prompts/*.md` |

项目来源在受信任后加载。补充发现到最近 Git 根目录为止，非 Git 目录查到文件系统根。每个目录只扫描直属 Markdown 文件，项目符号链接需仍位于对应模板目录内。

Pi 还接受 settings 的 `prompts` 和 `--prompt-template <path>`。同名模板保留最先加载者并报告冲突。

## 格式

```markdown
---
description: 审查代码
argument-hint: "<范围> [关注点]"
---
审查 $1。
额外关注：${@:2}
```

`description` 省略时取正文首个非空行，超过 60 字符后截断。`argument-hint` 显示在补全列表中。

## 参数

| 写法 | 含义 |
| --- | --- |
| `$1`、`$2` | 对应位置参数，缺失时为空 |
| `$@`、`$ARGUMENTS` | 全部参数，以空格连接 |
| `${N:-default}` | 第 N 个参数缺失或为空时取默认值 |
| `${@:-default}`、`${ARGUMENTS:-default}` | 全部参数为空时取默认值 |
| `${@:N}` | 从第 N 个参数开始 |
| `${@:N:L}` | 从第 N 个参数开始取 L 个 |

参数从 1 开始。单引号或双引号包裹的文本作为一个参数，替换结果不再次展开。

```text
/review src "并发安全"
```

Pi 负责解析与展开，`src/harness/extensions/agents-prompts.ts` 负责补充 `.agents/prompts` 路径。
