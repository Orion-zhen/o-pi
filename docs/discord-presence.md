# Discord Rich Presence

`agent/extensions/discord-presence.ts` 在交互式 TUI 会话中将 Pi 的当前活动发布到本机 Discord Desktop。Discord 通信由 `@xhayper/discord-rpc` 负责；配置、活动状态机、模板、限流和生命周期均由 o-pi 管理。

## 快速启用

默认使用公共 Pi Application ID `1520833162148712580`，并在 TUI 中启用。需要显式覆盖时，创建用户配置 `~/.pi/agent/configs/discord-presence.jsonc`：

```jsonc
{
	"enabled": true
}
```

重启 Pi、执行 Pi 的 `/reload`，或者在当前 session 中执行 `/presence on`。Discord Desktop 必须正在运行，并允许分享当前活动；浏览器版 Discord 不提供本地 IPC。

不希望公开项目和活动信息时，将用户或项目配置中的 `enabled` 设为 `false`。

## 配置分层

配置按以下顺序合并，后者覆盖前者：

```text
~/.pi/agent/defaults/discord-presence.jsonc
~/.pi/agent/configs/discord-presence.jsonc
<project>/.pi/configs/discord-presence.jsonc
```

普通对象递归合并，因此用户配置只需要写希望修改的字段。唯一例外是 `profiles.<name>.details`：它表示该 profile 订阅的完整活动集合，只要某一层写出 `details`，就会整体替换下层对象。未知字段、错误类型、非法 Application ID、无效 profile 和未知模板占位符会使配置加载失败，不会静默回退。

环境变量可以重定向配置路径：

| 环境变量 | 作用 |
| --- | --- |
| `PI_DISCORD_PRESENCE_CONFIG` | 重定向用户配置文件。 |
| `PI_DISCORD_PRESENCE_PROJECT_CONFIG` | 直接指定项目配置文件。 |
| `PI_DISCORD_PRESENCE_PROJECT_ROOT` | 指定查找 `.pi/configs/discord-presence.jsonc` 的项目根目录。 |

敏感项目可以只关闭自身 Presence：

```jsonc
{
	"enabled": false
}
```

## 顶层字段

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `$schema` | string | `../schemas/discord-presence.schema.json` | 编辑器 JSON Schema 提示，仅默认配置需要；用户覆盖层可以省略。 |
| `enabled` | boolean | `true` | 是否在 TUI session 启动时自动启用 Presence。运行时 `/presence on/off` 可临时覆盖。 |
| `application_id` | string | `1520833162148712580` | Discord Application ID，必须是 17～20 位数字。空字符串只允许在最终配置关闭时使用。它是公开标识，不是密钥。 |
| `update_interval_ms` | integer | `5000` | 两次 `SET_ACTIVITY` 发送尝试之间的最小间隔，允许 `5000`～`60000` 毫秒。低于 `15000` 属于实验性设置。 |
| `retry_interval_ms` | integer | `30000` | IPC 连接或 Activity 发送失败后的重试间隔，允许 `5000`～`300000` 毫秒。 |
| `profile` | string | `standard` | session 启动时使用的 profile 名称；必须存在于 `profiles`。 |
| `profiles` | object | 见默认配置 | 内置及用户定义 profile 的文本模板、活动订阅和计时设置。 |
| `assets` | object | 图片 key 为空 | 大图、小图、活动图标和语言图标设置。 |

最小持久配置：

```jsonc
{
	"enabled": true,
	"profile": "standard"
}
```

## `profiles`：展示档位

默认提供 `minimal`、`standard` 和 `detailed`，也可以增加任意符合 `^[a-z][a-z0-9_-]{0,31}$` 的 profile 名称。profile 不是不可绕过的隐私策略；模板中写入的数据仍会正常显示。

默认设计：

| 档位 | 默认展示 |
| --- | --- |
| `minimal` | 只订阅 `idle` 和 `thinking`，显示 `Pi Coding Agent`，不显示计时。 |
| `standard` | 订阅全部活动，显示模型和 session 计时。 |
| `detailed` | 订阅全部活动，额外显示正在读写的文件 basename，并显示 session 计时。 |

每个 profile 的字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `details` | object | 活动订阅及 Discord Presence 第一行模板；未写出的活动不触发 Presence 更新。 |
| `state` | string | Discord Presence 第二行，支持模板占位符。空字符串表示省略。 |
| `show_elapsed` | boolean | 是否从当前 Presence session 启动时间开始显示经过时长。 |

### `details` 活动字段

| 字段 | 触发条件 | 常用占位符 |
| --- | --- | --- |
| `idle` | `agent_settled` 后等待用户输入。 | `{project}`、`{session}` |
| `thinking` | turn 已开始，但当前没有正在执行的工具。 | `{project}`、`{model}` |
| `reading` | `read` 工具。 | `{file}`、`{language}` |
| `editing` | `edit` 工具。 | `{file}`、`{language}` |
| `writing` | `write` 工具。 | `{file}`、`{language}` |
| `searching` | `grep`、`find`、`ls`、`glob` 和代码符号搜索等本地搜索工具。 | `{tool}` |
| `browsing` | `websearch`、`webfetch`、`fetch`、`browse` 等网络工具。 | `{tool}` |
| `shell` | `bash` 工具；专门表示 Shell 命令，不泛指所有正在运行的工具。 | `{executable}` |
| `other_tool` | 未被其他类别匹配的工具，是 fallback 而不是所有工具的总类。 | `{tool}` |

并行工具执行时，最后启动且尚未结束的工具决定当前展示；它结束后会恢复到仍在运行的上一个工具。

`details` 中缺少的状态不会发布、清空或替换当前 Discord Activity。扩展仍在内部维护活动栈，以便后续进入已订阅状态时得到正确结果。例如默认 `minimal` 会在整个工具调用期间继续显示 `thinking`，直到 `agent_settled` 后更新为 `idle`。

空对象 `"details": {}` 表示该 profile 不因任何活动更新 Presence。切换到这种 profile 不会主动清除已显示的 Activity。

### 流式工具调用时机

工具状态不等待 host 开始执行。扩展监听模型输出中的 `toolcall_start`、`toolcall_delta` 和 `toolcall_end`：

```text
toolcall_start          -> 立即切换到工具类别
toolcall_delta          -> one-shot 补充稳定的 file/executable
toolcall_end            -> 补充 provider 未流式提供的最终参数
tool_execution_start    -> 兼容性兜底和最终校正
tool_execution_end      -> 结束工具状态
```

`{file}` 不读取不断变化的 partial path。扩展累积参数 JSON，只有顶层 `path` 字符串收到未转义的结束引号后，才取 basename 并设置一次。这样 `write` 即使继续生成很长的 `content`，文件名也不会从 `s`、`src`、`index` 多次变化；写入内容中出现的 `"path"` 不会被误识别。

`{executable}` 只有在首个非环境变量 Shell word 被未引用的空白或操作符终结后才设置一次。例如 `NODE_ENV=test npm run build` 会在 `npm ` 生成完成时确定为 `npm`。单 token 命令在 `toolcall_end` 时确定。

若 provider 不提供参数 delta，两者都会在 `toolcall_end` 一次性补充。已稳定识别的值不会被后续执行事件覆盖。`update_interval_ms` 仍会合并快速变化，但工具类别和稳定元数据会在最早可可靠观测的时刻进入待发送队列。

旧配置需要将 `running` 改为 `shell`、`tool` 改为 `other_tool`；旧字段不会作为兼容别名继续接受。模板占位符 `{tool}` 不变，它仍表示原始 Pi 工具名。

### 覆盖活动订阅和语句

`details` 是整对象覆盖。下面的配置使 `detailed` 只监控列出的活动：

```jsonc
{
	"profile": "detailed",
	"profiles": {
		"detailed": {
			"details": {
				"idle": "等待新的想法",
				"thinking": "正在设计下一步",
				"reading": "阅读 {file}",
				"editing": "修改 {file}",
				"writing": "创建 {file}",
				"searching": "追踪代码",
				"browsing": "查阅资料",
				"shell": "运行 {executable}",
				"other_tool": "使用 {tool}"
			},
			"state": "{project} · {model}",
			"show_elapsed": true
		}
	}
}
```

如果只写一句，那么其他状态会停止更新，这是有意行为：

```jsonc
{
	"profiles": {
		"detailed": {
			"details": {
				"thinking": "正在憋个大的"
			}
		}
	}
}
```

`state` 和 `show_elapsed` 仍按普通对象规则继承，无需在覆盖内置 profile 时重复。

### 自定义 profile

新 profile 没有下层值可继承，因此首次定义时必须提供 `details`、`state` 和 `show_elapsed`：

```jsonc
{
	"profile": "focus",
	"profiles": {
		"focus": {
			"details": {
				"thinking": "正在憋个大的",
				"editing": "给 {file} 做微创手术"
			},
			"state": "{project} · {model}",
			"show_elapsed": true
		}
	}
}
```

之后更高层配置可以继续覆盖 `focus`；选择不存在或定义不完整的 profile 会导致配置加载失败。

## 模板占位符

`profiles.*.details.*`、`profiles.*.state`、`assets.large.text` 和 `assets.small.text` 支持以下占位符：

| 占位符 | 值 | 可用范围 |
| --- | --- | --- |
| `{project}` | 当前工作目录的 basename，例如 `o-pi`。 | 所有活动 |
| `{model}` | 模型展示名；优先使用 model name，并移除 `/` 前缀。 | 所有活动 |
| `{session}` | Pi session 名；未命名时回退到项目名。 | 所有活动 |
| `{file}` | 完整 `path` 字符串闭合后 one-shot 提取的 basename，不包含目录。 | 主要用于 reading、editing、writing |
| `{language}` | 从稳定文件名扩展名识别的语言展示名，例如 `TypeScript`。 | 已识别文件语言时 |
| `{executable}` | 首个 Shell word 稳定后 one-shot 提取的 basename，例如 `git`。前置环境变量和其余参数不会包含。 | shell |
| `{tool}` | Pi 原始工具名。 | 工具活动 |
| `{label}` | 已识别文件使用语言名，否则使用 `Idle`、`Thinking`、`Terminal` 等活动标签。 | 常用于小图 tooltip |

缺少上下文的占位符会渲染为空；`{executable}` 缺失时回退为 `command`。未知占位符会使配置加载失败。

所有文本都会：

1. 将换行和 Tab 转为空格；
2. 合并连续空白；
3. 截断到 Discord 的 128 字符边界；
4. 在最终文本少于 2 个字符时省略该字段。

完整路径、完整 Bash 命令、搜索词、URL 和 prompt 没有对应占位符，不能被模板意外公开。

## `assets`：图片与 tooltip

图片必须属于当前 `application_id` 对应的 Discord Application。配置中的 key 必须与 Discord Developer Portal 中上传的 Rich Presence Art Asset 名称一致；不存在的 key 无法显示。

### `assets.large`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `key` | string | `""` | 大图资源 key。空字符串表示不发送大图。 |
| `text` | string | `Pi Coding Agent` | 鼠标悬停大图时的 tooltip；支持模板。只有设置了 `key` 才会发送。 |

### `assets.small`

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `text` | string | `{label}` | 小图 tooltip 模板。只有最终选中了小图时才会发送。 |
| `default` | string | `""` | 找不到语言图标和活动图标时使用的资源 key；空字符串表示省略小图。 |
| `activities` | object | 所有值为空 | 按 `idle`、`thinking`、`reading` 等活动映射资源 key。字段名与 `details` 活动字段一致。 |
| `languages` | object | `{}` | 按内置语言标识映射资源 key。可以只配置已上传的语言图标。 |

小图选择优先级：

```text
语言图标 > 活动图标 > default > 不发送小图
```

支持的语言标识：

```text
c cpp css go html java javascript json lua markdown python ruby rust
shell sql toml typescript vue xml yaml zig
```

其中 JSONC 使用 `json`，JSX 使用 `javascript`，TSX 使用 `typescript`，YML 使用 `yaml`。

### 公共 Pi Application 图片示例

默认不发送图片。公共 Application 已知可使用 `pi_logo`、`shell` 和一组语言资源，可以按需覆盖：

```jsonc
{
	"assets": {
		"large": {
			"key": "pi_logo",
			"text": "Pi：这次一定能跑"
		},
		"small": {
			"text": "{label} · 赛博搬砖中",
			"default": "pi_logo",
			"activities": {
				"thinking": "pi_logo",
				"shell": "shell"
			},
			"languages": {
				"typescript": "ts",
				"javascript": "js",
				"python": "python",
				"rust": "rust",
				"go": "go",
				"json": "json",
				"markdown": "markdown",
				"shell": "shell",
				"lua": "lua",
				"toml": "toml",
				"yaml": "yaml"
			}
		}
	}
}
```

公共 Application 的名称和资源由其所有者控制；需要稳定的自定义品牌时应使用自己的 Application。

## 使用自己的 Discord Application

1. 在 <https://discord.com/developers/applications> 创建 Application；应用名称决定 Discord 显示的 “Playing …” 名称。
2. 复制 **Application ID**。Presence 不需要 Bot Token 或 Client Secret。
3. 在 Rich Presence Art Assets 中上传图片；Discord 建议使用 1024x1024 图片。
4. 覆盖 Application ID 和资源 key：

```jsonc
{
	"enabled": true,
	"application_id": "123456789012345678",
	"assets": {
		"large": {
			"key": "my_pi_logo",
			"text": "My Pi Setup"
		}
	}
}
```

Application ID 是公开标识，可以写入配置；不要把 Client Secret、Bot Token 或 OAuth Token 写入 Presence 配置。

## 运行时命令

| 命令 | 说明 |
| --- | --- |
| `/presence on` | 当前 session 临时启用；即使配置中的 `enabled` 为 `false` 也会启用。 |
| `/presence off` | 当前 session 临时关闭，并清除 Discord Activity。 |
| `/presence status` | 显示开关状态、当前 profile 和 Discord 连接状态。 |
| `/presence reload` | 重新读取默认、用户和项目配置；保留当前 session 的运行时开关/profile 覆盖。 |
| `/presence profile <name>` | 当前 session 切换到内置或用户定义 profile；命令补全会读取当前配置。 |

`on`、`off` 和 profile 选择不会写入配置。新 session 会重新使用配置中的 `enabled` 和 `profile`。

快速状态变化会合并，并按 `update_interval_ms` 限制发送频率；首个状态在没有前序发送时仍会立即发送。相同 payload 不会重复发送。Discord 不可用时 Pi 不会被阻塞，最新状态会按 `retry_interval_ms` 重试。

Discord 旧版 Rich Presence 文档明确给出每 15 秒一次更新；当前 RPC 文档不再承诺固定数字。当前默认使用实验性的 `5000`；需要保守行为时可改为：

```jsonc
{
	"update_interval_ms": 15000
}
```

更短的本地发送间隔不保证其他用户更快看到变化；Discord 仍可能合并更新或返回 RPC `RATE_LIMITED`。

## 完整自定义示例

```jsonc
{
	"enabled": true,
	"application_id": "1520833162148712580",
	"update_interval_ms": 5000,
	"retry_interval_ms": 30000,
	"profile": "detailed",
	"profiles": {
		"minimal": {
			"state": "Coding with Pi",
			"show_elapsed": false
		},
		"standard": {
			"state": "{project}",
			"show_elapsed": true
		},
		"detailed": {
			"details": {
				"idle": "Waiting in {project}",
				"thinking": "Planning the next change",
				"reading": "Inspecting {file}",
				"editing": "Refining {file}",
				"writing": "Creating {file}",
				"searching": "Tracing the codebase",
				"browsing": "Checking references",
				"shell": "Running {executable}",
				"other_tool": "Using {tool}"
			},
			"state": "{project} · {model}",
			"show_elapsed": true
		}
	},
	"assets": {
		"large": {
			"key": "pi_logo",
			"text": "{session}"
		},
		"small": {
			"text": "{label}",
			"default": "pi_logo",
			"activities": {
				"thinking": "pi_logo",
				"shell": "shell"
			},
			"languages": {
				"typescript": "ts",
				"javascript": "js",
				"python": "python",
				"rust": "rust"
			}
		}
	}
}
```

未写出的普通字段继续继承 `agent/defaults/discord-presence.jsonc`；示例中的 `detailed.details` 会作为完整活动集合替换默认值。

## 隐私与限制

默认模板不会发布完整路径、Bash 参数、搜索词、URL 或用户 prompt。默认可公开的数据仅包括项目 basename、文件 basename、简化模型名、session 名、工具名和 Bash 可执行程序名。

同一系统用户的多个 TUI Pi 由按需启动的本地协调进程合并为一个 Discord RPC 连接。最近发布状态的 Pi 获得展示权；它退出或执行 `/presence off` 后，协调器回退到剩余 Pi 中最近活跃者的最后状态。`/presence reload`、切换 profile、模型或 session 不会离开协调组。

开启 `show_elapsed` 时，所有参与者使用共享起点：第一个启用 Presence 的 Pi 加入时开始，第一进程退出后继续，最后一个参与者退出或关闭 Presence 时结束；之后建立的新组重新计时。协调进程异常重启时，存活客户端会携带原起点和最后状态重新注册。

协调进程使用当前系统用户私有的本地 socket，并在最后一个参与者离开后清除 Activity、关闭 Discord RPC 并退出。Pi 不会等待协调器或 Discord 建立连接；无响应的本地连接会超时重建，最近状态会在后台恢复后重新注册。不同 Pi 可以有不同 profile、资源和 Application ID；展示权切换时会同步切换配置。其他非 Pi Presence 应用仍由 Discord 自行仲裁。该扩展不会为 print、JSON 或 RPC 模式发布 Presence。
