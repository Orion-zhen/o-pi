# 忽略规则引擎

本文说明 `.piignore`、`.gitignore`、内置规则和 Git 已跟踪文件集合如何参与文件发现。忽略规则不用于访问控制。路径安全规则见[路径与安全](path-security.md)。

## 两个独立维度

```text
忽略规则：路径是否应从自动发现、遍历、搜索或索引中排除
路径解析：把相对或绝对输入交给文件系统操作
```

自动发现、递归搜索和索引默认跳过软忽略路径。但是，调用方明确提供路径时，`ls`、`find`、`grep`、`read`、`write` 和 `edit` 仍可访问该路径。文件系统访问策略内核会强制拒绝或跳过受阻路径。忽略规则诊断不会解除受阻路径的访问限制。

## 规则来源

系统默认读取根目录和嵌套目录中的 `.piignore` 与 `.gitignore`。规则来源的优先级从高到低排列如下：

1. 会话覆盖规则。
2. `.piignore`。
3. `.gitignore`。
4. `.git/info/exclude`，默认关闭。
5. Git 全局排除规则，默认关闭。
6. 内置规则。

同一来源中，子目录规则优先于父目录规则。同一文件中，后面的匹配规则覆盖前面的规则。规则使用工作区相对的字面路径匹配，内部统一使用 `/`。符号链接的真实路径不会改写逻辑路径。

## 决策模型

可见性操作会明确携带意图：`list-entry`、`traverse`、`search`、`index`、`explicit-read` 或 `explicit-edit`。操作意图和调用方是否明确指定根路径，共同决定系统应标记、过滤还是允许穿过软忽略路径。受阻路径不属于可见性决策。

匹配结果不是简单的布尔值：

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

`ignored` 与 `prune` 相互独立。路径可以被忽略，但如果后代可能被 `!pattern` 重新包含，遍历器就不能安全剪枝。`prune` 只影响后续遍历、搜索和索引。`ls` 始终只列直属成员。

## 调用状态与快照

每次文件系统调用都会获得一个可见性求值器。求值器绑定以下状态：

- 有效配置。
- Git 已跟踪文件集合。
- 内置规则。
- 会话覆盖规则。

`FileSystemRuntime` 开始调用时只准备固定规则和 Git 状态，不递归发现忽略规则文件。目录枚举把同一份 `readdir` 快照交给可见性求值器。求值器在处理子项前，按需读取并编译当前目录中的 `.gitignore` 和 `.piignore`。规则顺序仍按来源优先级和目录深度稳定排列。明确调用的 `read`、`ls` 或非根搜索范围只准备目标祖先链，不扫描无关目录。

同一次调用中，已加载的规则保持不变。后续调用会从实际目录快照重新读取遇到的规则文件。因此，`edit` 修改 `.piignore` 或 `.gitignore` 后，下一次工具调用会立即看到新规则。Git 索引和配置仍根据指纹缓存并失效。

独立且完整的 `VisibilitySnapshot` API 保持不可变，并提供同步的 `evaluate` 和 `explain` 语义，供规则解释和运行时之外的调用使用。

增量加载不能破坏 `!pattern` 语义。如果软忽略目录可能被尚未加载的嵌套同级规则或更高优先级规则重新包含，运行时会先检查该子树中的规则文件，再决定是否剪枝。`.git`、`node_modules` 和不可覆盖的配置或会话忽略规则仍可直接剪枝。

## Git 已跟踪文件

系统默认通过 `git ls-files -z` 批量读取已跟踪文件集合：

- 已跟踪文件不受 `.gitignore` 软忽略规则影响。
- `.piignore` 仍可忽略已跟踪文件。
- 非 Git 仓库会退化为空的已跟踪文件集合。

## 解释信息与诊断

`explain` 可以定位最终生效的规则来源：

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

忽略规则文件只支持 UTF-8，读取时会剥离 BOM。读取或编码错误会产生结构化诊断。系统会继续应用其他有效规则，不会因诊断而阻止访问。诊断不会直接写入 `ls` 条目，以免工具输出膨胀。开发者可以使用快照的 `explain` 调试规则。
