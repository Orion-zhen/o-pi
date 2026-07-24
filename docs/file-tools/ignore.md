# Ignore engine

本文说明 `.piignore`、`.gitignore`、builtin rules 和 Git tracked set 如何参与文件工具发现。ignore 不是访问控制；路径安全规则见 [路径与安全](path-security.md)。

## 两个独立维度

```text
ignore：路径是否应从自动发现、遍历、搜索或索引中排除
路径解析：把相对或绝对输入交给文件系统操作
```

soft ignored 路径默认不进入自动发现、递归搜索和索引，但明确提供路径时仍可被 `ls`、`find`、`grep`、`read`、`write` 和 `edit` 访问。blocked path 则由 path guard 拒绝或跳过。

## 规则来源

默认支持根目录和嵌套目录中的 `.piignore` 与 `.gitignore`。规则来源优先级从高到低：

1. session override；
2. `.piignore`；
3. `.gitignore`；
4. `.git/info/exclude`，默认关闭；
5. Git global excludes，默认关闭；
6. builtin rules。

同一来源中，子目录规则优先于父目录规则；同一文件中，后面的匹配规则覆盖前面的规则。规则使用 workspace-relative lexical path 匹配，内部统一使用 `/`，不会用 symlink realpath 改写逻辑路径。

## 决策模型

匹配结果不是简单 boolean：

```ts
type IgnoreDecision = {
  state: "none" | "ignore" | "include";
  ignored: boolean;
  prune: boolean;
  matchedRule?: {
    sourceType: "builtin" | "gitignore" | "piignore" | "git-info-exclude" | "global" | "session";
    sourcePath?: string;
    line?: number;
    pattern: string;
    negated: boolean;
    baseDirectory: string;
  };
  diagnostics?: IgnoreDiagnostic[];
};
```

`ignored` 与 `prune` 分开：路径可以被忽略，但如果后代可能被 `!pattern` 重新包含，遍历器不能安全剪枝。`prune` 只影响未来遍历、搜索和索引；`ls` 仍然只列直属成员。

## Snapshot

每次工具调用创建一个不可变 ignore snapshot。snapshot 绑定：

- 有效配置；
- 规则文件版本；
- Git tracked set；
- builtin rules；
- session override。

`evaluate` 和 `explain` 不读取磁盘。引擎按 workspace 缓存 snapshot；稳定命中只并发核对已发现目录、规则文件和 Git index/config 的 metadata，不重新遍历规则目录或启动 Git 子进程。

同 workspace、同配置的并发调用共享一次 snapshot 构建。目录、规则文件、tracked set 或配置变化会生成新 snapshot；失效中的旧构建不能重新写回缓存。`edit` 修改 `.piignore` 或 `.gitignore` 后，后续调用通过新 snapshot 看到新规则。

## Git tracked files

默认通过 `git ls-files -z` 批量读取 tracked set：

- tracked 文件不受 `.gitignore` soft ignore 影响；
- `.piignore` 仍可忽略 tracked 文件；
- 非 Git 仓库安全退化为空 tracked set。

## Explain 与诊断

`explain` 可以定位最终规则来源：

```json
{
  "path": "dist/schema.json",
  "ignored": true,
  "prune": false,
  "trace": [
    {
      "sourceType": "piignore",
      "sourcePath": ".piignore",
      "line": 3,
      "pattern": "dist/"
    }
  ],
  "winner": {
    "sourceType": "piignore",
    "sourcePath": ".piignore",
    "line": 3,
    "pattern": "dist/"
  }
}
```

ignore 文件默认只支持 UTF-8，BOM 会被剥离。读取或编码错误会产生结构化 diagnostics，并 fail-open 继续应用其他有效规则。diagnostics 不直接塞进 `ls` entry，以免工具输出膨胀；开发者可以使用 snapshot `explain` 调试。
