# Discord Rich Presence

`agent/extensions/discord-presence.ts` 在交互式 TUI 会话中把 Pi 的当前活动发布到本机 Discord Desktop。`@xhayper/discord-rpc` 负责 Discord IPC，o-pi 负责配置、活动状态、模板、发送频率和生命周期。

该扩展只在 TUI 模式下发布活动，不支持打印、JSON 或 RPC 模式。Discord Desktop 必须正在运行，并允许分享当前活动。浏览器版 Discord 不提供本地 IPC。

## 快速启用

默认配置使用内置 Discord 应用 ID `1540224977184358430`，并启用 Discord Presence。通常不需要创建用户配置。可以通过以下任一方式重新启动或启用：

- 重启 Pi。
- 执行 Pi 的 `/reload`。
- 在当前会话中执行 `/presence on`。

需要显式覆盖时，创建 `~/.pi/agent/configs/discord-presence.jsonc`：

```jsonc
{
	"enabled": true
}
```

不希望某个项目发布活动时，在该项目的 `.pi/configs/discord-presence.jsonc` 中写入：

```jsonc
{
	"enabled": false
}
```

## 配置分层

配置按以下顺序合并，后者覆盖前者：

```text
<o-pi>/agent/defaults/discord-presence.jsonc
~/.pi/agent/configs/discord-presence.jsonc
<project>/.pi/configs/discord-presence.jsonc
```

普通对象递归合并。`profiles.<name>.details` 是例外。任一配置层写出 `details` 后，该对象会整体替换低层值，因为它表示该档位订阅的完整活动集合。

未知字段、错误类型、非法应用 ID、不存在或不完整的展示档位，以及未知模板占位符都会导致配置加载失败。加载器不会静默回退。通用规则见[配置分层](configuration.md)。

环境变量可以重定向配置路径：

| 环境变量 | 作用 |
| --- | --- |
| `PI_DISCORD_PRESENCE_CONFIG` | 重定向用户配置文件。 |
| `PI_DISCORD_PRESENCE_PROJECT_CONFIG` | 直接指定项目配置文件。 |
| `PI_DISCORD_PRESENCE_PROJECT_ROOT` | 指定项目根目录，并读取其中的 `.pi/configs/discord-presence.jsonc`。 |

## 顶层字段

当前默认值以 `agent/defaults/discord-presence.jsonc` 为准。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `$schema` | `string` | `../schemas/discord-presence.schema.json` | 编辑器使用的 JSON Schema 路径。用户和项目覆盖配置可以省略。 |
| `enabled` | `boolean` | `true` | 是否在 TUI 会话启动时启用 Presence。运行时命令可以临时覆盖。 |
| `application_id` | `string` | `1540224977184358430` | Discord 应用 ID，必须是 17 至 20 位数字。最终配置关闭时可以使用空字符串。该 ID 是公开标识，不是密钥。 |
| `update_interval_ms` | `integer` | `5000` | 两次活动发送尝试之间的最小间隔。取值范围为 5000 至 60000 毫秒。 |
| `retry_interval_ms` | `integer` | `30000` | IPC 连接或活动发送失败后的重试间隔。取值范围为 5000 至 300000 毫秒。 |
| `profile` | `string` | `standard` | 会话启动时使用的展示档位，必须存在于 `profiles`。 |
| `profiles` | `object` | 见默认配置 | 活动订阅、文本模板和计时设置。 |
| `assets` | `object` | 见默认配置 | 大图、小图、活动图标和语言图标。 |

最小持久覆盖配置：

```jsonc
{
	"profile": "detailed"
}
```

## 展示档位

默认提供 `minimal`、`standard` 和 `detailed` 三个展示档位。默认选中 `standard`。

| 档位 | 默认行为 |
| --- | --- |
| `minimal` | 只订阅 `idle` 和 `thinking`。显示固定的活动文本和 `O Pi`，不显示计时。 |
| `standard` | 订阅全部活动。显示通用活动文本、简化模型名和进程计时。Shell 活动显示可执行程序名，其他未分类工具显示工具名。 |
| `detailed` | 订阅全部活动。空闲状态增加项目名，文件活动增加文件基本名，并显示简化模型名和进程计时。 |

每个展示档位包含以下字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `details` | `object` | 活动订阅和 Discord Presence 第一行模板。未配置的活动不会触发发布。 |
| `state` | `string` | Discord Presence 第二行模板。渲染为空或少于两个字符时省略。 |
| `show_elapsed` | `boolean` | 是否显示从 Pi 进程启动时间开始计算的经过时长。 |

展示档位名称必须匹配 `^[a-z][a-z0-9_-]{0,31}$`。新名称没有低层值可继承，因此首次定义时必须同时提供 `details`、`state` 和 `show_elapsed`。

展示档位控制展示内容，但不是不可绕过的隐私边界。模板中引用的数据会正常发布。

### 活动类型

| 字段 | 触发条件 | 常用占位符 |
| --- | --- | --- |
| `idle` | `agent_settled` 后等待用户输入。 | `{project}`、`{session}` |
| `thinking` | 已开始一轮交互，但没有工具正在执行。 | `{project}`、`{model}` |
| `reading` | 执行 `read`。 | `{file}`、`{language}` |
| `editing` | 执行 `edit`。 | `{file}`、`{language}` |
| `writing` | 执行 `write`。 | `{file}`、`{language}` |
| `searching` | 执行 `grep`、`find`、`ls`、`glob`、`search`、`code_pattern`、`lsp_workspace_symbols`、`lsp_references` 或 `lsp_definition`。 | `{tool}` |
| `browsing` | 执行 `webfetch`、`websearch`、`fetch`、`browse` 或 `fetch_content`。 | `{tool}` |
| `shell` | 执行 `bash`。 | `{executable}` |
| `other_tool` | 执行未归入其他类型的工具。 | `{tool}` |

并行执行工具时，最后启动且尚未结束的工具决定当前活动。该工具结束后，扩展会恢复到仍在运行的上一个工具。所有工具结束后，如果当前轮次尚未结束，则恢复为 `thinking`。`agent_settled` 后切换为 `idle`。

如果当前档位没有订阅新活动，扩展不会发布或清除 Discord 中已有的活动，但仍会更新内部活动栈。例如，`minimal` 在工具执行期间继续显示先前的 `thinking`，并在 `agent_settled` 后更新为 `idle`。

空对象 `"details": {}` 表示不因任何活动发布更新。切换到该档位不会主动清除 Discord 中已有的活动。

### 流式工具调用

扩展会在模型生成工具调用时尽早更新活动，不等待工具开始执行：

```text
toolcall_start       -> 切换到工具类型
toolcall_delta       -> 补充已稳定的文件名或可执行程序名
toolcall_end         -> 使用最终参数补充尚未识别的信息
tool_execution_start -> 校正工具类型和参数
tool_execution_end   -> 结束工具活动
```

对于文件工具，扩展只在顶层 `path` JSON 字符串收到结束引号后提取一次文件基本名。后续生成的 `content` 不会反复改变文件名，内容中的嵌套 `path` 也不会被识别为目标路径。

对于 `bash`，扩展只在首个非环境变量 Shell 单词被空白或操作符终结后提取一次可执行程序基本名。例如，`NODE_ENV=test npm run build` 会识别为 `npm`。只有一个单词的命令会在 `toolcall_end` 时识别。

已经稳定识别的文件名或可执行程序名不会被后续执行事件覆盖。`update_interval_ms` 可能合并快速状态变化，因此 Discord 实际显示的时间可能晚于内部活动切换时间。

旧配置中的活动字段 `running` 和 `tool` 已分别改为 `shell` 和 `other_tool`，不再作为兼容别名接受。模板占位符 `{tool}` 没有变化，仍表示原始 Pi 工具名。

### 覆盖现有档位

以下配置把 `detailed` 的活动集合缩减为三个状态。`state` 和 `show_elapsed` 继续继承默认值：

```jsonc
{
	"profile": "detailed",
	"profiles": {
		"detailed": {
			"details": {
				"idle": "等待输入",
				"thinking": "规划下一步",
				"editing": "修改 {file}"
			}
		}
	}
}
```

由于 `details` 整体替换，未列出的活动不会发布更新。

### 自定义档位

```jsonc
{
	"profile": "focus",
	"profiles": {
		"focus": {
			"details": {
				"thinking": "专注规划",
				"editing": "修改 {file}"
			},
			"state": "{project} · {model}",
			"show_elapsed": true
		}
	}
}
```

## 模板占位符

`profiles.*.details.*`、`profiles.*.state`、`assets.large.text` 和 `assets.small.text` 支持以下占位符：

| 占位符 | 值 |
| --- | --- |
| `{project}` | 当前工作目录的基本名。 |
| `{model}` | 模型的展示名。优先使用模型名称，并只保留最后一个 `/` 后的部分。 |
| `{session}` | Pi 会话名。未命名时使用项目名。 |
| `{file}` | 文件路径稳定后提取的基本名，不包含目录。 |
| `{language}` | 根据文件扩展名识别的语言名称，例如 `TypeScript`。 |
| `{executable}` | Shell 命令中首个非环境变量单词的基本名。无法识别时使用 `command`。 |
| `{tool}` | 原始 Pi 工具名。 |
| `{label}` | 已识别文件使用语言名称，其他情况使用活动标签。 |

缺少上下文的占位符会渲染为空，但 `{executable}` 使用上述回退值。符合 `{[a-z_]+}` 形式但不在表中的占位符会导致配置加载失败。

所有模板文本都会经过以下处理：

1. 把换行符和制表符转换为空格。
2. 合并连续空白并删除首尾空白。
3. 最多保留 128 个 Unicode 字符。超长文本以省略号结尾。
4. 最终文本少于两个字符时省略该字段。

扩展没有完整路径、完整 Bash 命令、搜索词、URL 或用户提示词对应的占位符。

## 图片资源

图片必须属于 `application_id` 对应的 Discord 应用。资源键必须与该应用中的 Rich Presence Art Asset 名称一致。不存在的资源键不会显示图片。

`assets.large` 字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `key` | `""` | 大图资源键。空字符串表示不发送大图。 |
| `text` | `O Pi` | 大图悬浮文本模板。只有选中大图时才发送。 |

`assets.small` 字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `text` | `{label}` | 小图悬浮文本模板。只有选中小图时才发送。 |
| `default` | `""` | 没有语言或活动图标时使用的资源键。空字符串表示不发送小图。 |
| `activities` | 九种活动映射到同名资源键 | 按活动类型选择资源键。 |
| `languages` | `{}` | 按内置语言键选择资源键。 |

因此，默认配置不发送大图，也不按语言选择小图。默认配置会为九种活动发送同名的小图资源键。图片是否显示取决于当前 Discord 应用是否包含对应资源。

小图选择优先级：

```text
语言图标 > 活动图标 > default > 不发送小图
```

支持的语言键：

```text
c cpp css go html java javascript json lua markdown python ruby rust
shell sql toml typescript vue xml yaml zig
```

JSONC 使用 `json`，JSX 使用 `javascript`，TSX 使用 `typescript`，YML 使用 `yaml`。

图片配置示例：

```jsonc
{
	"assets": {
		"large": {
			"key": "my_logo",
			"text": "{session}"
		},
		"small": {
			"text": "{label}",
			"default": "my_logo",
			"activities": {
				"thinking": "thinking",
				"shell": "terminal"
			},
			"languages": {
				"typescript": "typescript",
				"python": "python"
			}
		}
	}
}
```

某一层配置 `assets.small.activities` 或 `assets.small.languages` 时，这些普通对象会递归合并。只需写需要覆盖的资源键。如果要禁用继承的活动图标，应把对应活动的资源键显式设置为空字符串。

## 使用自己的 Discord 应用

1. 在 <https://discord.com/developers/applications> 创建 Discord 应用。
2. 复制应用 ID。Presence 不需要 Bot Token 或 Client Secret。
3. 如需图片，在 Rich Presence Art Assets 中上传资源。
4. 覆盖应用 ID 和资源键：

```jsonc
{
	"enabled": true,
	"application_id": "123456789012345678",
	"assets": {
		"large": {
			"key": "my_logo",
			"text": "My Pi Setup"
		}
	}
}
```

切换应用 ID 后，应确保继承的 `assets.small.activities` 资源键也存在于新应用中。不需要的继承资源键可以显式设置为空字符串。

应用 ID 是公开标识，可以写入配置。不要把 Client Secret、Bot Token 或 OAuth Token 写入 Presence 配置。

## 运行时命令

以下命令只在 TUI 模式下可用：

| 命令 | 说明 |
| --- | --- |
| `/presence` 或 `/presence status` | 显示开关状态、当前展示档位和 Discord 连接状态。 |
| `/presence on` | 临时启用当前会话，即使配置中的 `enabled` 为 `false`。 |
| `/presence off` | 临时关闭当前会话，并从本地协调组移除当前 Pi。 |
| `/presence reload` | 重新读取默认、用户和项目配置。保留运行时开关覆盖，并在原档位仍存在时保留档位覆盖。 |
| `/presence profile <name>` | 临时切换到内置或用户定义的展示档位。命令补全读取当前配置。 |

`on`、`off` 和档位选择不会写入配置。新的 Pi 会话重新使用配置中的 `enabled` 和 `profile`。

发送器会合并快速状态变化，并按 `update_interval_ms` 限制发送尝试。新的协调进程没有前次发送时，首个状态会立即发送。连接正常时，相同载荷不会重复发送。Discord 不可用时，Pi 不等待连接完成，发送器会按 `retry_interval_ms` 重试最新状态。

更短的本地发送间隔不保证 Discord 客户端更快显示变化。需要降低更新频率时，可以设置：

```jsonc
{
	"update_interval_ms": 15000
}
```

## 隐私

默认的 `standard` 档位不会发布项目名、会话名、文件名、完整路径、Bash 参数、搜索词、URL 或用户提示词。它会发布简化模型名。执行 `bash` 时还会发布可执行程序名，执行未分类工具时会发布工具名。

`detailed` 档位会额外发布项目基本名和文件基本名。自定义模板还可以发布表格中列出的其他值。配置展示档位前，应根据项目敏感程度检查模板和活动订阅。

## 多进程协调

同一系统用户启动的多个 TUI Pi 通过按需启动的本地协调进程共享一个 Discord RPC 连接。最近发布活动的 Pi 获得展示权。该 Pi 退出或执行 `/presence off` 后，协调器会恢复剩余 Pi 中最近活跃者的最后状态。

不同 Pi 可以使用不同的展示档位、图片资源和应用 ID。展示权切换时，协调器会同步切换配置和 Discord 应用。其他程序发布的 Discord Presence 仍由 Discord 自行协调。

启用 `show_elapsed` 时，每个参与者提交当前 Pi 进程的启动时间。协调组使用自该组建立以来参与过的最早进程起点，直到最后一个参与者离开。`/new`、`/resume`、`/fork`、`/reload`，以及执行 `/presence off` 后重新启用，都不会改变同一 Pi 进程的起点。只有启动新的 Pi 进程才会产生新的起点。

协调进程异常重启后，存活客户端会携带原起点和最后状态重新注册。无响应的本地连接会超时并重建，恢复后不需要新的活动事件即可重新发布最后状态。

在 Unix 平台上，协调器目录权限设置为 `0700`，套接字权限尽力设置为 `0600`。Windows 使用按当前用户身份区分的命名管道。最后一个参与者离开后，协调进程会清除活动、关闭 Discord RPC、删除本地端点并退出。
