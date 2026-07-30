# Ignore engine

本文说明 `.piignore`、`.gitignore`、builtin rules 和 Git tracked set 如何参与文件工具发现。ignore 不是访问控制；路径安全规则见 [路径与安全](path-security.md)。

## 两个独立维度

```text
ignore：路径是否应从自动发现、遍历、搜索或索引中排除
路径解析：把相对或绝对输入交给文件系统操作
```

soft ignored 路径默认不进入自动发现、递归搜索和索引，但明确提供路径时仍可被 `ls`、`find`、`grep`、`read`、`write` 和 `edit` 访问。blocked path 则由 filesystem access-policy kernel 强制拒绝或跳过，不能因 ignore diagnostics 而 fail-open。

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

visibility operation 显式携带 intent：`list-entry`、`traverse`、`search`、`index`、`explicit-read` 或 `explicit-edit`。intent 与 root 是否明确决定 ignored 路径是 annotation、过滤还是允许穿过；blocked 不属于 visibility decision。

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

## Invocation state 与 snapshot

每次 filesystem invocation 获得绑定以下状态的 visibility evaluator：

- 有效配置；
- Git tracked set；
- builtin rules；
- session override。

`FileSystemRuntime` 启动 invocation 时只准备固定规则和 Git 状态，不递归发现 ignore 文件。目录枚举把同一份 `readdir` 快照交给 visibility：当前目录中的 `.gitignore` / `.piignore` 在处理子项前按需读取和编译，规则顺序仍按来源优先级和目录深度稳定排序。显式 `read`、`ls` 或非根 scope 只准备目标祖先链，不扫描无关目录。

一个 invocation 内已经加载的规则保持不变；后续 invocation 会从实际目录快照重新读取遇到的规则文件，因此 `edit` 修改 `.piignore` 或 `.gitignore` 后下一次工具调用立即看到新规则。Git index/config 仍按 fingerprint 缓存和失效。独立的完整 `VisibilitySnapshot` API 保留不可变、纯同步 `evaluate` / `explain` 语义，供规则解释和非 runtime 调用使用。

增量加载不能破坏 `!pattern` 语义：若 ignored 目录可能被尚未加载的嵌套同级或更高优先级规则重新包含，runtime 会先检查该子树的规则文件，再决定 `prune`。`.git`、`node_modules` 和不可覆盖的 config/session ignore 仍直接剪枝。

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
