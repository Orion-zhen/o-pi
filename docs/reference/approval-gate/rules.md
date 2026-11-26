# 审批规则

## Bash 分析

Tree-sitter 将 Shell 输入拆为简单命令、嵌套替换、静态 `-c` 子脚本和文件写重定向。命令单元保留原文和解析后的参数数组。一次调用只准备一份命令、工作目录和启动环境。审批检查原命令以及 `skill://` 路径替换后的命令，批准后使用同一份快照执行。`/approval-check` 走相同的准备流程，不执行命令。

解析器按执行顺序跟踪赋值、工作目录、有限循环取值、静态函数调用和 EXIT trap。命令替换和进程替换各自继承外层状态。替换内的赋值和目录变化影响同一替换的后续语句，不影响外层。Bash 审批与技能路径解析共用引号和转义解码。

分支按当前注册的 EXIT 动作合并，未注册动作的分支单独保留。分析器在退出时用对应分支的变量和工作目录分析清理命令，而不是使用注册时的快照。同一合并点超过 8 种注册状态时，按分析超限处理。

每组分支中，每个变量和工作目录最多保留 8 个候选。`cd ./build` 后的相对路径按成功和失败两种目录检查。`CDPATH` 为空或未设置时，`cd build` 与 `cd ./build` 按相同路径检查。非空时还检查每个搜索目录，相对项基于当前工作目录，不探测目录是否存在。无法确定搜索路径时保留未知候选。任一已知写入目标命中 deny 即拒绝。

程序名或 `-c` 脚本来自有限分支时，解析器逐一检查候选。所有候选都是参数确定的直接调用时，不因分支本身要求审批。管道中的间接调用仍保留动态审批，因为单个候选不能代表整条管道。取值未知或超出分析预算时，不按部分候选放行。

在启动状态已知的非 Windows Bash 中，独立的 `$name` 或 `${name}` 可解析为一个字段，包括程序名、参数和重定向目标。值必须非空，且只含字母、数字等不会触发分词或文件名展开的路径字符。`case "$MODE"` 的选择值确定、模式均为简单字面量或 `*`、每项以 `;;` 结束时，只分析第一个匹配项。Windows Bash 可能转换环境路径，SSH 启动的 Bash 可能读取启动文件，这两种情况不做上述收窄。条件读取的启动值也计入会话记忆限制。

这两项推断从脚本开头和已选中的分支开头生效，可经过简单字面赋值和不改写状态的 `echo`、`:`、`true`、`false`。遇到修改 `IFS`、设置 Shell 选项或其他未建模的前置语句后，不再用启动时的分词和匹配规则排除可能性。

写重定向的父目录已知、文件名含一个数字展开时，解析器保留文件名前后缀，不猜测实际数值。支持 PID、退出状态，以及已知来自 Bash 且未失效的 `RANDOM`、`BASHPID`、`PPID`、`UID` 和 `EUID`。这类目标不能记忆为精确路径。单引号或转义后的 `$` 仍是字面文本。

当前 `HOME` 是已知绝对路径时，未引用的 `~` 和 `~/` 使用该路径展开。无参数 `cd` 的成功分支也使用该路径。`HOME` 未设置时不查询系统账户目录。

已知字符串支持字面前后缀裁剪和 `${name##*/}`。`${name:-default}` 和 `${name-default}` 区分空值、已清除和未知值。默认值可以是单个 `$变量名`，仅在选中默认值时读取。普通变量从工具过滤、注入后的启动环境取初值，不读取其他会话的环境。Shell 自行维护的变量不按普通环境值推断。启动脚本或导入函数使初始状态不确定时保留不透明审批。子 Shell 不直接继承父分析器的变量表。依赖启动值或启动状态未知的请求不保存会话授权。脚本用独立值覆盖或清除变量后，后续读取不再依赖该变量的启动值。

审批面板只列出分析用到的启动值。请求用到按名称识别的敏感值时，面板默认显示源表达式，不显示展开后的目标。GUI 的「相关变量」位于命令下方，默认折叠。展开可查看变量名和取值，空字符串与未设置分别标注。只有点击「查看敏感值」才读取当前弹窗的明文详情。收起变量列表也会重新隐藏敏感值。

`set --` 按原位置参数展开实参，再替换位置参数。解析器保留首个不确定参数之前的字面量、可确定为单个字段的变量、可确定的双引号参数和 `~/` 路径。函数调用不继承调用者的位置参数。在启动状态仍可确定的非 Windows Bash 前缀中，`cd ./dir || exit 1` 只有成功分支能继续执行。紧随其后的 `||` 分支不会生成审批单元。遇到函数遮蔽、退出重定向或 EXIT trap 时仍检查两条分支。

语法错误、超时、资源不可用或复杂度超限时，解析器为完整输入追加 `shell.run-opaque-input` 事实，已分析的单元仍参与审批。无法确定程序名或子脚本时也产生这个事实。不透明输入可在当前会话精确记忆。

## 临时范围

临时范围包括有效 `mktemp` 创建的路径，以及宿主进程启动时 `os.tmpdir()` 指定目录的后代。临时根必须是绝对路径，不能是文件系统根。目录名本身不产生豁免。`mktemp` 支持静态模板、`-d`、`--suffix`、`--tmpdir` 和 `-p`。

Windows 按盘符或 UNC 共享解析绝对路径，不把 Bash 的单根路径或盘符相对路径补全到当前盘符。无法确定宿主映射的重定向仍按动态目标审批。

完全位于该范围的重定向、删除、write、edit，以及临时工作区的 `git clean` 和 `git reset --hard` 可跳过 ask。

路径比较不跟随符号链接。临时根本身、规范化后越界的路径、混合目标、可能分词的裸变量、`rmdir -p`、提权和无法确定的控制流无法获得豁免。显式 deny 仍优先。

## 事实与动作

每个工具在 `tools.<tool>.facts` 下按 ID 定义事实。新建 `write`、`edit` 或 `webfetch` 事实必须指定 `action`，取值为 `ask` 或 `deny`。合并配置后，指定 `action` 的事实和组合必须有非空白的 `reason`，可继承默认值。`ask` 在审批界面展示原因。仅因 `default_action: "ask"` 而需要确认的目标显示通用提示。`deny` 向代理返回规则 ID 和原因原文，不附带命令或参数值。显式 `deny` 优先于询问、临时范围和会话放行。要匹配该工具的所有审批目标，使用 `match_all: true`，不再指定其他匹配条件。

Bash 事实可由分析器、写入目标 `path_globs` 或 `commands` 中任一分类器产生。默认配置在对应事实旁注明了分析器的检查。仅作为组合条件的 Bash 事实可同时省略 `action` 和 `reason`。`/approval-check` 显示命中的事实和分类器名称。

```jsonc
"facts": {
  "history.read": { "commands": { "read-file": { "arg_globs": ["**/*.bash_history", "**/*.zsh_history", "**/*.custom_history"] } } },
  "project.deploy": {
    "action": "ask", "reason": "This operation may deploy the project or publish build artifacts.",
    "commands": {
      "deploy": { "command": ["pnpm", "run", "deploy"] },
      "upload": { "command": ["corp-upload"], "arg_globs": ["dist/**"] },
      "publish-stream": { "pipeline": [["build-tool", "pack"], ["corp-publish"]] }
    }
  }
}
```

- `command` 的首项用 glob 匹配程序的基本名称，后续各项按位置匹配。整项 `"*"` 占一个参数，不能匹配缺失的位置。`{a,b}` 接受 `a` 或 `b` 两个字面值，不能嵌套。`foo*`、`?` 仍按字面匹配。`command`、`except` 和 `pipeline` 的命令前缀都遵循这条约定。旧配置中单独的 `"*"` 不再只匹配星号本身。规则检查直接调用和解析器可解包的调用。Windows 上明确指定 `sc`、`sc.exe` 或两者的组合 `{sc,sc.exe}` 时，程序名和第一个操作名不区分大小写。Git、Docker、Podman、`gh` 和下述包管理器还会在全局选项后匹配子命令。例如 `["git", "push"]` 匹配 `git -C repo push`，不匹配 `git -C push status` 或 `git log --grep push`。
- 不设 `exact: true` 和 `arg_globs` 时，`["git", "子命令", "--选项"]` 和 `["wget", "--选项"]` 会在 `--` 之前查找该选项，不要求它紧跟子命令或程序名。Git 匹配完整参数，wget 也匹配 `--选项=值`。例如 `git reset HEAD --hard` 命中硬重置规则，`git reset HEAD -- --hard` 中的 `--hard` 是路径，不命中。
- 同样不设 `exact: true` 和 `arg_globs` 时，`["curl", "选项"]` 在 `--` 之前按选项前缀匹配。`rm`、`chmod`、`chown` 的规则以选项开头时，列出的每组参数都必须出现，顺序不限。短选项可以合写，`--` 之后的文本不算选项，文件名和权限值仍按整个参数匹配。
- `exact: true` 要求没有尾随参数。`arg_globs` 要求前缀之后至少一个参数完整匹配任一 glob，区分大小写。两者不能同用。匹配同时检查原文和统一分隔符、折叠 `.` 与 `..` 后的文本。值未知时检查去掉外层引号的源词，不展开变量。匹配不区分文件名、搜索词和选项值。例如 `grep -F .env README.md` 和 `grep -f .env README.md` 都命中 `configuration.read-sensitive`，默认询问。
- `except` 只用于 `command` 规则。每项是含程序名的命令前缀，任一项确定匹配，只跳过当前命令候选的这条规则。其他候选、规则和命令照常检查。例外要求能确认匹配，不把用于触发审批的推测视作豁免依据。用户配置省略 `except` 时继承默认列表，指定数组时整体替换，`[]` 清除全部例外。
- `pipeline` 至少包含两个阶段，按顺序匹配同一条管道，中间可以有其他命令。每个阶段写成命令前缀数组，或用 `{ "command": [...], "arg_globs": [...] }` 限定该阶段的参数。阶段不能嵌套管道。例如 `[["build-tool", "pack"], ["corp-publish"]]` 匹配 `build-tool pack | gzip | corp-publish`，不匹配反向顺序或两条独立管道。命中时显示整条管道，不按单个阶段记忆授权。
- 每条规则只能选 `command` 或 `pipeline`，两者都可用 `platform` 限制当前进程平台：`linux`、`darwin` 或 `win32`。

Docker 和 Podman 共用 `container-*` 规则。例如，`podman inspect prune` 命中 `container-remove` 的查询例外，不需审批。`podman push prune` 也命中该例外，但仍由 `container-push` 要求审批。`container-remove` 的 `arg_globs` 匹配参数，不判断该参数是不是操作名，因此 `docker --context rm build .` 也会命中。

`remote-rsync` 的 `arg_globs` 同时覆盖 `host:file` 和 `host:/dir/file`。即使主机名未知，源参数 `"$host:/dir/file"` 也会命中。`find-env-to-cat` 只在 `find` 阶段检查 `.env` 模式，后面同一管道还必须出现 `xargs cat`。

`git-clean-force` 识别合写的 `-f`。只有可确认 `-n` 或 `--dry-run` 生效时才跳过这条规则。含空格的字面路径不影响预演判断。`--` 后的 `-n` 是路径，不构成预演。

Git 全局选项取值后才匹配子命令。`git -C "$dir" status` 中，`-C` 的值即使未知也只占一个参数。若改用裸变量，或未知选项可能取走 `status`，分析器保留其他候选，不能仅凭 `status` 命中例外。

`["systemctl", "*"]` 和 `["launchctl", "*"]` 的 `"*"` 匹配全局选项之后的操作名。`systemctl --user` 没有操作名，`systemctl -H status restart nginx` 的操作是 `restart`。`["service", "*", "*"]` 要求服务名和操作名都存在。`service nginx status` 命中查询例外，`service status restart` 不命中。若服务名来自可能分词或展开为多个文件名的参数，就不能确认 `status` 的位置，仍需审批。

Bash 读取 `.env`、`.env.local` 或 `.env.production` 等敏感配置时默认询问。同一次调用还命中对外传输规则时，`configuration.exfiltrate` 直接拒绝。以 `.env.example`、`.env.sample` 或 `.env.template` 结尾的文件按模板处理，不因该文件名询问。普通 `config.yaml` 和 `config.yml` 也不命中这条规则。SSH 私钥和云凭据仍由 `credential.read` 默认拒绝。

`/approval-check git push origin main` 显示 `network.write-external` 下的 `git-push`。在该事实的 `commands` 下设置 `"git-push": false` 只禁用 Git 推送规则，不影响容器镜像推送。仍由分析器识别的条件显示为 `analysis`。

`package.change` 的操作全部列在[默认配置](../../../agent/defaults/approval-gate.jsonc)的 `commands` 中。规则按工具和命令组归类。`/approval-check bun add lodash` 显示 `bun`，`/approval-check pacman -Syu` 显示 `pacman`。在 `commands` 下写 `"pacman": false` 即可禁用该组，不影响其他分类器。

- 包管理器按子命令匹配。`pip install ruff` 命中 `pip`，`pip help install` 和 `npm run ci` 不命中安装规则。`npm --prefix "my project" run ci` 中的目录名只占一个参数，仍按 `npm run` 判断。全局选项和 Cargo 工具链前缀不是子命令，例如 `apt-get -y install curl` 命中 `apt`，`cargo +stable install ripgrep` 命中 `cargo`。遇到不确定的选项或转发命令时，后续参数也作为候选位置。分析器不读取项目脚本或锁文件。
- 对于 `run`，只有 Bun、uv 和 Yarn 会继续匹配可能转发的包管理器命令。例如 `uv run pip install ruff` 命中安装规则。`cargo run --example install` 中的 `install` 是示例名，不命中安装规则。
- pacman 的非精确命令前缀若以单个短选项开头，也检查 `--` 之前的组合短选项。例如 `-Syu` 匹配 `-S`，`-- -S` 不匹配 `-S`。

`tools.bash.combinations` 在同一次 Bash 调用命中所列全部事实时升级动作，路径事实也可参与组合。Bash 的默认 `deny` 拒绝整次调用，记忆规则和临时范围不能覆盖。其他工具的默认动作只处理未命中事实且未豁免的目标。

用户覆盖按 ID 递归合并，对象保留未指定的字段，数组整体替换。上例只改写 `history.read` 的路径，沿用默认读取命令和动作。写 `commands: {}` 不会清除继承的分类器。将事实、`commands` 下的分类器或组合的值设为 `false` 即可禁用。禁用事实也会停用引用它的组合。引用不存在的事实会导致配置加载失败。

### 迁移内置规则 ID

如果用户配置覆盖了下列事实或组合（包括设为 `false`），请改用新 ID，并更新自定义组合 `all` 中的引用。旧 ID 不会自动映射到新 ID。

| 旧 ID | 新 ID |
| --- | --- |
| `system-path-write` | `filesystem.write-system-path` |
| `private-network-fetch` | `network.fetch-private` |
| `network.external-write` | `network.write-external` |
| `filesystem.destructive` | `filesystem.discard-data` |
| `system.catastrophic` | `system.disrupt-host` |
| `execution.remote-script` | `shell.run-downloaded-script` |
| `execution.opaque` | `shell.run-opaque-input` |
| `privilege.escalation` | `privilege.escalate` |
| `environment-exfiltration` | `environment.exfiltrate` |
| `configuration-exfiltration` | `configuration.exfiltrate` |
| `broad-scan-exfiltration` | `host.exfiltrate-scan-results` |

### 已合并的默认命令规则

`.env` 的读取规则已从 `credential.read` 移到 `configuration.read-sensitive`。如果覆盖过 `.env` 路径或 `find-env-to-cat` 管道，请在新事实下调整对应规则。

如果用户配置覆盖了下表的旧命令规则 ID，请在同一事实的 `commands` 下改用新 ID。

| 事实 | 旧命令规则 ID | 新 ID |
| --- | --- | --- |
| `environment.read-all` | `env`、`printenv` | `list-all` |
| `host.scan-broad` | `root`、`home`、`root-home` | `find-roots` |
| `network.write-external` | `ssh`、`nc`、`ncat`、`socat` | `remote-connection` |
| `network.write-external` | `scp`、`sftp` | `file-transfer` |
| `network.write-external` | `npm`、`pnpm`、`yarn`、`cargo` | `package-publish` |
| `network.write-external` | `docker-push` | `container-push` |
| `network.write-external` | `docker-image-push` | `container-image-push` |
| `filesystem.discard-data` | `docker-system-prune` | `container-system-prune` |
| `infrastructure.change` | `docker-remove` | `container-remove` |

新 ID 控制整组命令。例如，`"file-transfer": false` 同时禁用 `scp` 和 `sftp` 的默认规则。如果只想让 `scp` 不再触发该规则，写 `"file-transfer": { "command": ["sftp"] }`。

`service.change` 不再内置 Windows 的 `sc-operation`。原来依赖这条规则的用户配置若仍需审批 `sc` 或 `sc.exe`，须自行指定 `command`。

## 路径规则

```json
{
  "tools": {
    "write": {
      "facts": {
        "filesystem.write-system-path": {
          "action": "ask", "path_globs": ["/etc/**", "/usr/**", "/System/**"],
          "reason": "system path modification"
        }
      }
    }
  }
}
```

`write`、`edit` 的 `path_globs` 匹配目标文件，Bash 的 `path_globs` 匹配写重定向目标。普通命令参数不是写入目标，要匹配它们，应在 `commands` 分类器中使用 `arg_globs`。

`path_globs` 的目标转为使用 `/` 的绝对路径，技能保留 `skill://`。glob 使用 picomatch，`*` 匹配一个路径段，`**` 跨段，数组任一命中即可。

Bash 默认的 `filesystem.write-system-path` 使用 `arg_globs`，只检查指定文件操作命令的参数，不把相对参数补全为绝对路径。`cp /etc/hosts ./hosts` 即使只从系统目录读取，也会命中。`ls /etc/hosts` 和单纯写重定向不命中这条规则。要按重定向目标审批，可另配 Bash `path_globs`。

## webfetch 网络范围

`tools.webfetch.facts` 用 `network_scope` 限定初始 URL 的网络范围：`public`、`private` 或 `loopback`。要让直连回环也询问审批，可添加 `{ "network_scope": "loopback", "action": "ask", "reason": "This request accesses a local service." }`。范围由[网络层](../web-tools/network.md)在执行前判定，无法判定时阻止调用。要无条件禁止抓取，可以添加 `{ "match_all": true, "action": "deny", "reason": "Network access is disabled." }`。

## 会话授权

授权只匹配同一工具。Bash 命令匹配请求工作目录和规范化后的完整子命令，文件操作匹配精确路径，webfetch 请求匹配完整 origin 和网络范围。授权只保存在内存中。GUI 回收执行实例时保留当前逻辑会话的授权，新会话和分支不会继承。
