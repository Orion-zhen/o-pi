# Prompt Templates

Pi 内置 prompt template 会把 Markdown 文件注册成 `/name` 模板命令。本仓库额外通过 `agent/extensions/agents-prompts.ts` 暴露 `.agents` 目录中的模板路径，解析和参数替换仍由 Pi 内置 loader 完成。

用户级模板：

```text
~/.pi/agent/prompts/*.md
~/.agents/prompts/*.md
```

项目级模板：

```text
.pi/prompts/*.md
.agents/prompts/*.md
```

行为：

* `~/.agents/prompts` 始终按用户级资源加载。
* 项目 `.agents/prompts` 只在 Pi project trust 生效时加载。
* 项目 `.agents/prompts` 会从当前目录向上查找祖先目录，遇到 Git 根目录停止。
* 项目 `.agents/prompts` 只返回目录内真实 `.md` 文件，拒绝符号链接逃逸。
* Markdown frontmatter 的 `description` 会作为 `/name` 模板命令的展示描述。
* 同名模板的最终冲突处理沿用 Pi 内置 prompt template loader。
