# 审批规则

## Bash 分析

Tree-sitter 将 Shell 输入拆为简单命令、嵌套替换、静态 `-c` 子脚本和文件写重定向。命令单元保留原文和解析后的参数数组。一次调用只准备一份命令、工作目录和启动环境。审批检查原命令以及 `skill://` 路径替换后的命令，批准后使用同一份快照执行。`/approval-check` 走相同的准备流程，不执行命令。

解析器按执行顺序跟踪赋值、工作目录、有限循环取值、静态函数调用和 EXIT trap。命令替换和进程替换各自继承外层状态。替换内的赋值和目录变化影响同一替换的后续语句，不影响外层。Bash 审批与技能路径解析共用引号和转义解码。

分支按当前注册的 EXIT 动作合并，未注册动作的分支单独保留。分析器在退出时用对应分支的变量和工作目录分析清理命令，而不是使用注册时的快照。同一合并点超过 8 种注册状态时，按分析超限处理。

每组分支中，每个变量和工作目录最多保留 8 个候选。同一次分支合并得到的一组标量保留各分支的取值组合。后续重赋值不沿用被覆盖变量的关联。`cd ./build` 后的相对路径按成功和失败两种目录检查。`CDPATH` 为空或未设置时，`cd build` 与 `cd ./build` 按相同路径检查。非空时还检查每个搜索目录，相对项基于当前工作目录，不探测目录是否存在。无法确定搜索路径时保留未知候选。任一已知写入目标命中 deny 即拒绝。

程序名或 `-c` 脚本来自有限分支时，解析器逐一检查候选。所有候选都是参数确定的直接调用时，不因分支本身要求审批。管道中的间接调用仍保留动态审批，因为单个候选不能代表整条管道。取值未知或超出分析预算时，不按部分候选放行。

在启动状态已知的非 Windows Bash 中，独立的 `$name` 或 `${name}` 可解析为一个字段，包括程序名、参数和重定向目标。值必须非空，且只含字母、数字等不会触发分词或文件名展开的路径字符。`case "$MODE"` 的选择值确定、模式均为简单字面量或 `*`、每项以 `;;` 结束时，只分析第一个匹配项。Windows Bash 不用继承值做这种收窄，但可识别当前脚本前缀中刚赋值的单字段字面量。SSH 启动的 Bash 可能读取启动文件，不做上述收窄。条件读取的启动值也计入会话记忆限制。

这两项推断从脚本开头和已选中的分支开头生效，可经过简单字面赋值和不改写状态的 `echo`、`:`、`true`、`false`。遇到修改 `IFS`、设置 Shell 选项或其他未建模的前置语句后，不再用启动时的分词和匹配规则排除可能性。

写重定向的父目录已知、文件名含一个数字展开时，解析器保留文件名前后缀，不猜测实际数值。支持 PID、退出状态，以及已知来自 Bash 且未失效的 `RANDOM`、`BASHPID`、`PPID`、`UID` 和 `EUID`。这类目标不能记忆为精确路径。单引号或转义后的 `$` 仍是字面文本。

当前 `HOME` 是已知绝对路径时，未引用的 `~` 和 `~/` 使用该路径展开。无参数 `cd` 的成功分支也使用该路径。`HOME` 未设置时不查询系统账户目录。

已知普通字符串支持 `+=`、字面前后缀裁剪和 `${name##*/}`。`${name:+word}` 和 `${name+word}` 只在选中替代值时读取它。可解析的值还包括简单 Bash `$'…'` 引号、字面数组的固定下标和内建 `printf -v name %s` 的确定参数。`${name:-default}` 和 `${name-default}` 区分空值、已清除和未知值。默认值可以是单个 `$变量名`，仅在选中默认值时读取。普通变量从工具过滤、注入后的启动环境取初值，不读取其他会话的环境。Shell 自行维护的变量不按普通环境值推断。启动脚本或导入函数使初始状态不确定时保留不透明审批。子 Shell 不直接继承父分析器的变量表。依赖启动值或启动状态未知的请求不保存会话授权。脚本用独立值覆盖或清除变量后，后续读取不再依赖该变量的启动值。

审批面板只列出分析用到的启动值。请求用到按名称识别的敏感值时，面板默认显示源表达式，不显示展开后的目标。GUI 的「相关变量」位于命令下方，默认折叠。展开可查看变量名和取值，空字符串与未设置分别标注。只有点击「查看敏感值」才读取当前弹窗的明文详情。收起变量列表也会重新隐藏敏感值。

`set --` 按原位置参数展开实参，再替换位置参数。解析器保留首个不确定参数之前的字面量、可确定为单个字段的变量、可确定的双引号参数和 `~/` 路径。参数列表完整时，独立的 `"$@"` 按字段展开，固定步数的 `shift` 按位置移动参数。只设置 Shell 标志不替换参数。省略 `in` 的 `for` 遍历位置参数。循环体能确定正常完成时，循环后的语句使用末次迭代的状态。

在绑定仍可确定时，函数调用使用到达调用点的定义。EXIT trap 中的命令也按退出时可达的定义分析，命令名本身仍参与规则匹配。可跟踪的函数体在 `local` 声明处保存被遮蔽的绑定，返回时还原局部变量和调用者的位置参数。字面 `[[ … ]]` 比较和不受遮蔽的 `exit` 可排除不可达路径。遇到退出重定向可能失败、EXIT trap 或未建模的控制转移时保留其他路径。没有子命令的 `exec` 仍检查自身及其文件重定向。

语法错误、超时、资源不可用或复杂度超限时，解析器为完整输入追加 `shell.run-opaque-input` 事实，已分析的单元仍参与审批。无法确定程序名或子脚本时也产生这个事实。不透明输入可在当前会话精确记忆。

## PowerShell 分析

`$env:` 来自本次执行准备好的环境，名称按 Windows 规则忽略大小写。普通赋值、完整变量和静态文本中的简单变量插值可生成命令、参数及重定向路径候选。同一次插值重复读取同一变量时沿用同一个候选。`if` 可按布尔常量和已知字符串比较排除分支。其他条件只检查求值时的操作、可能到达的分支和异常处理，不预测比较结果。

有限标量列表按顺序展开 `foreach`，并保留已知字符串类型。不带标签的 `break` 离开当前已建模循环，`continue` 进入下一轮。`return` 结束当前脚本或函数。控制转移仍经过对应的 `finally`。`exit` 结束当前路径并执行沿途的 `finally`。若退出参数需要在运行时求值，审批器也检查可能的异常处理和后续操作，不验证退出码的类型。遇到未建模的循环跳转时，仍检查可能到达的后续迭代和循环外语句。

`[IO.File]` 和 `[System.IO.File]` 的单路径 `ReadAllLines`、`ReadAllText` 调用按 `Get-Content -LiteralPath` 的读取规则检查，后者带 `-Raw`。插值中的 `$PWD` 使用当前文件系统位置，.NET 相对路径使用进程工作目录。审批器不预读文件。读取 `.Length` 或用 `-match` 检查内容不需要知道实际值。

字面字符串直接调用固定名称的方法（如 `' report '.Trim()`），以及 `[guid]::NewGuid()` 和紧随其后的 `.ToString()`，不因返回值未知而询问。审批器仍检查字符串插值、方法参数和可能进入的 `catch`。例如 `'report'.Contains($(git push))` 只按推送规则询问。如果把结果当作命令或写入目标，仍按该用途审批。未知对象、动态方法名、能执行回调的 `.ForEach()` 和 `.Where()` 不按普通字符串处理。

只有能确认操作数为字符串时才计算 `+` 拼接。普通变量在所有分支都是字符串时，也可以用作 `if` 字符串比较的左操作数。完整分析后没有执行单元的脚本仍按整段检查默认动作和 `match_all`，例如注释加赋值或未调用的函数声明。将命令输出赋给普通变量时，仍检查命令本身。直接重复使用同一个普通变量时，各参数沿用同一候选值。多个参数的候选组合超出预算时，只把无法继续展开的参数记为未知，继续检查其余参数和后续操作。普通数据参数未知不会把整段脚本标为不透明。未知参数可能命中启用的命令、路径参数或管道规则时，提示可能命中的规则，不将其视为已证实的拒绝事实。已知处于文件系统位置时，`Join-Path` 支持普通相对基路径或带盘符的绝对基路径，子路径须为普通相对路径。位置参数和完整命名参数 `-Path`、`-ChildPath` 均可使用。后续命令和重定向检查计算结果，`Join-Path` 本身仍参与命令规则匹配。

管道和连续语句分别检查各条命令。普通查询和属性投影不会使先前的变量或工作目录变为未知。例如 `Get-Process | Select Name,CPU` 不影响后续重定向路径。`-OutVariable dir` 只让 `$dir` 多一个未知候选，不影响其他变量。传给已识别原生程序的 `-OutVariable` 是普通参数。切换目录更新位置候选。动态执行或未检查的脚本可能改写会话状态，后续操作不能依赖旧状态获得豁免。若脚本显式修改别名、导入模块等，使后续命令名的含义也无法确定，则仍需按不透明输入处理。审批器不执行外部命令来检查其内部行为。

参数按源码中未转义的空格和制表符分隔，即使语法树省略了分隔节点。`git status --short -- src` 中的 `--` 是独立参数，带引号的路径和反引号转义的空格仍属于原参数。`-Filter *.ts` 中的模式是确定的参数，不需要枚举文件。

审批器用本地语法树和源码判断最终脚本能否执行，不启动 PowerShell 预检。能确认整段有语法错误时不询问，由执行器返回原生错误和退出码。例如 `git diff -- src/{path-match,policy}.ts` 中未引用的花括号不是 Bash 式文件名展开。仅凭语法树报错、嵌套脚本出错或分析超时不能豁免。整工具的拒绝规则仍然生效。

参数位置的 `$dir/file.ts` 和 `$env:TEMP/sub/file.ts` 各是一个可展开路径。审批器只在能验证完整参数边界时恢复这类路径，不忽略其他语法错误。审批面板按操作列出原因。遇到未知命令名、动态脚本输入或未知重定向目标时，只标记对应操作。子脚本嵌套过深或待分析输入已满时，只标记无法继续解析的操作，仍检查后续操作和已排队的输入。整段无法解析或整体分析超限时才追加整段提示。嵌套脚本不展示展开后的源片段。

普通属性读取不需要证明接收方的运行时类型。例如 `(Get-Command echo).Definition` 只检查 `Get-Command` 调用。

直接用 `Resolve-Path` 查询单个普通文件系统路径时，审批器保留其他变量和工作目录，不把输入当成已解析的返回值。`New-Item -ItemType Directory` 创建已知目录后接 `| Out-Null` 不影响已有变量。创建 Junction 时，链接位置和目标都参与命令参数匹配。目标无法确定时，不能仅因链接位置在临时目录就放行。

对于 `Join-Path` 拼接带盘符的基路径和 `('prefix-' + [guid]::NewGuid().ToString('N'))`，审批器可跟踪父目录和字面前缀。直接执行 `New-Item -ItemType Directory -Path $dir` 时，审批面板用 `<guid:N>` 表示未知的 32 位十六进制文件名后缀。命令和目录路径都参与规则匹配，不因目录位于 `TEMP` 而豁免。复杂模式不能排除时按可能命中处理。

对已建模的 cmdlet，参数名与冒号后的值分别参与匹配，字面逗号列表保留为一个参数。例如在 `Select-String -Pattern 'a,b' -Context 3,4` 中，`a,b` 是一个字符串，`3,4` 是一个有两个成员的列表。规则可匹配列表成员，不能仅凭一个成员命中 `except`。原生程序不使用这种列表绑定。

`Select` 的默认别名和完整名称 `Select-Object` 都参与命令与管道规则匹配。上游对象的值未知时，仍可逐项检查 `Select Name,CPU` 或 `Select-Object -Property Name,CPU` 中的字面属性名，无需读取实际属性值。命令绑定不确定时不按内置 cmdlet 推断。计算属性中的脚本块仍按代码检查。

筛选、排序和投影不需要登记属性或预测管道的输出类型。每个阶段仍参与管道规则匹配，回调、计算属性和命令替换中可见的调用也参与审批。回调可能重复执行，因此下一轮也检查上一轮可能修改的变量和位置。若某个值或位置的候选持续增加，只放宽这一项，不将其他变量一同标为未知。

例如 `exit $env:RESULT` 不因退出码未知而询问，`exit $(git push)` 则按推送规则审批。

`catch` 使用可能发生异常时的状态。单独求值已识别的静态字符串或十进制整数字面量不会进入 `catch`。`finally` 分别检查进入它的各条路径。正常完成清理不会将退出变为继续执行。

在同一确定作用域里，顺序声明的同名函数以最后一个为准。未知条件结束后，后续调用检查各分支可能定义的函数。无默认表达式的普通参数支持位置和完整参数名绑定，也保留 `$args[0]` 等固定下标。已知字符串可绑定到 `[string]` 参数。分析器按到达调用点的定义判断本地函数，不以函数名是否含连字符判定副作用。普通函数调用保留调用方的局部变量和位置参数，但环境变量的修改可随调用返回。函数内的未知副作用不会因此消失。默认别名可能优先于同名函数，因此分析器不单凭命名函数体内的 `exit` 跳过调用后的语句。

直接调用 `pwsh` 或 `powershell` 并显式指定 `-NoProfile` 时，若 `-Command` 后只有一个能原样传给子进程的字面脚本，审批器分别检查外层调用和内层脚本。脚本中的函数、大括号和分号本身不会触发询问。脚本来自未知值、从标准输入读取，或包含无法确认传递方式的双引号时，仍需确认。子命令不能单独记忆，也不获得临时范围豁免。

PowerShell 多行字符串作为标准输入时，与 Bash heredoc 使用相同的审批边界：检查外层命令、参数、管道和重定向，不分析接收程序执行的正文。例如，将导入本地模块的脚本传给 `bun run -`、`node -` 或 `python -`，默认不因导入语句或正文长度而询问。放行不表示已检查脚本或模块的副作用。需要确认这类调用时，可按接收命令配置 `ask` 或 `deny`。

单引号多行字符串里的 `$(...)` 是文本。双引号多行字符串里的 PowerShell 展开仍由分析器检查，无法确定的外层调用仍按不透明输入处理。

`Set-Location` 和 `Push-Location` 的静态路径保留成功与失败两种位置。`Pop-Location` 按各分支自己的默认位置栈恢复。盘符已知时，单根路径按该盘解析。`-LiteralPath` 下的方括号按字面目录名处理。非文件系统提供程序、通配路径、未知调用的副作用和不支持的位置栈操作不能用于证明文件目标。分析超限或输入不透明时保留已经识别的单元，并追加 `shell.run-opaque-input`。

文件重定向、单目标 `Remove-Item` 和限定形式的 `git clean` 只有在所有候选目标都在系统临时目录下时才能豁免询问。

只有独立的顶层静态命令才能按单元记忆。管道阶段、函数体内的命令和依赖先前位置变化的命令不能单独复用。启动环境参与分析时，整个请求不记忆。

## 临时范围

临时范围包括有效 `mktemp` 创建的路径，以及宿主进程启动时 `os.tmpdir()` 指定目录的后代。临时根必须是绝对路径，不能是文件系统根。目录名本身不产生豁免。`mktemp` 支持静态模板、`-d`、`--suffix`、`--tmpdir` 和 `-p`。

Windows 按盘符或 UNC 共享解析宿主绝对路径。Bash 写重定向若能确定单根绝对路径，如 `/dev/null`，则按 Bash 路径匹配，不补全盘符，也不授予临时目录豁免或会话授权。宿主目录变量、盘符和 UNC 模式需要 Windows 路径。`**/System32/**` 这类未锚定的 glob 也可能匹配挂载点背后的宿主目录。若 Bash 路径未命中，且未知映射会影响这些规则或组合的决策，则要求确认，不把可能命中当作确定拒绝。目标本身未知或只有盘符相对路径时，仍按动态目标审批。

完全位于临时范围的 Bash 重定向、删除、write 和 edit 可跳过 ask。Bash 和 PowerShell 对直接调用的 `git clean` 和 `git reset --hard` 使用相同的临时范围条件：按顺序解析 `-C` 后，所有候选工作目录都必须在临时范围内。启动环境或脚本可能通过 Git 环境变量改选工作树、索引或配置时，不授予豁免。`clean` 只接受由 `fdnqxX` 组成的短选项。`reset` 的 `--` 之后是路径，不是重置选项。

路径比较不跟随符号链接。临时根本身、规范化后越界的路径、混合目标、可能分词的裸变量、`rmdir -p`、提权和无法确定的控制流无法获得豁免。显式 deny 仍优先。

## 事实与动作

每个工具在 `tools.<tool>.facts` 下按 ID 定义事实。新建 `write`、`edit` 或 `webfetch` 事实必须指定 `action`，取值为 `ask` 或 `deny`。合并配置后，指定 `action` 的事实和组合必须有非空白的 `reason`，可继承默认值。`ask` 在审批界面展示原因。仅因 `default_action: "ask"` 而需要确认的目标显示通用提示。`deny` 向代理返回规则 ID 和原因原文，不附带命令或参数值。显式 `deny` 优先于询问、临时范围和会话放行。要匹配该工具的所有审批目标，使用 `match_all: true`，不再指定其他匹配条件。

Shell 事实可由分析器、写入目标 `path_globs` 或 `commands` 中任一分类器产生。默认配置在对应事实旁注明了分析器的检查。仅作为组合条件的 Shell 事实可同时省略 `action` 和 `reason`。`/approval-check` 显示命中的事实和分类器名称。

```jsonc
"facts": {
  "history.read": { "commands": { "read-file": { "arg_globs": ["**/*.bash_history", "**/*.zsh_history", "**/PSReadLine/ConsoleHost_history.txt", "**/*.custom_history"] } } },
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
- 每个分类器只能选 `command` 或 `pipeline`。`platform` 限制运行平台（`linux`、`darwin` 或 `win32`），`shell` 限制发起调用的工具（`bash` 或 `powershell`）。两个条件都省略时不限，同时指定时必须都满足。事实或组合上的 `shell` 限制整条规则，分类器不能放宽所属事实的范围。
- PowerShell 按程序基本名称匹配，不区分该名称的大小写。共享规则不会把 PowerShell 别名或参数自动翻译成 Unix 命令或选项。内置的 `read-file` 用同一份路径列表检查 `cat` 和 `Get-Content`。

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

`tools.shell.combinations` 在同一次 Shell 调用命中所列全部事实时升级动作，路径事实也可参与组合。Shell 的默认 `deny` 拒绝整次调用，记忆规则和临时范围不能覆盖。其他工具的默认动作只处理未命中事实且未豁免的目标。

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

`write`、`edit` 的 `path_globs` 匹配目标文件，Shell 的 `path_globs` 匹配分析器识别的写重定向目标。普通命令参数不是写入目标，要匹配它们，应在 `commands` 分类器中使用 `arg_globs`。

`path_globs` 的目标转为使用 `/` 的绝对路径，技能保留 `skill://`。glob 使用 picomatch，`*` 匹配一个路径段，`**` 跨段，数组任一命中即可。

`path_globs` 和 `arg_globs`（包括管道阶段）都可以用宿主目录变量作为第一个完整路径段：

- `$HOME/.ssh/id_*` 中的 `$HOME` 表示当前用户的主目录，适用于 Windows、macOS 和 Linux。
- `$NAME`、`${NAME}` 和 PowerShell 的 `$env:NAME` 读取宿主环境变量。例如 `${XDG_CONFIG_HOME}/gh/hosts.yml` 要求宿主已设置 `XDG_CONFIG_HOME`。
- Windows 还支持 `%APPDATA%/GitHub CLI/hosts.yml`、`%ProgramFiles(x86)%/**`。其他平台只跳过对应的 `%NAME%` 模式。同一列表的其他模式仍生效。列表中没有适用模式时，不匹配任何目标。

变量在加载配置时解析一次，不受待审批命令中的赋值影响。当前平台适用的变量必须指向绝对路径，否则配置加载失败。变量值按字面目录匹配，Windows 忽略目录前缀的大小写。后缀仍按原有 glob 规则匹配。`arg_globs` 不会把相对参数补全到变量目录。

Shell 默认的 `filesystem.write-system-path` 使用 `arg_globs`，只检查指定文件操作命令的参数，不把相对参数补全为绝对路径。`cp /etc/hosts ./hosts` 即使只从系统目录读取，也会命中。`ls /etc/hosts` 和单纯写重定向不命中这条规则。要按重定向目标审批，可另配 Shell `path_globs`。

## webfetch 网络范围

`tools.webfetch.facts` 用 `network_scope` 限定初始 URL 的网络范围：`public`、`private` 或 `loopback`。要让直连回环也询问审批，可添加 `{ "network_scope": "loopback", "action": "ask", "reason": "This request accesses a local service." }`。范围由[网络层](../web-tools/network.md)在执行前判定，无法判定时阻止调用。要无条件禁止抓取，可以添加 `{ "match_all": true, "action": "deny", "reason": "Network access is disabled." }`。

## 会话授权

授权只匹配同一工具。Bash 和 PowerShell 不共享会话授权。Shell 命令匹配请求工作目录和规范化后的完整子命令，文件操作匹配精确路径，webfetch 请求匹配完整 origin 和网络范围。授权只保存在内存中。GUI 回收执行实例时保留当前逻辑会话的授权，新会话和分支不会继承。
