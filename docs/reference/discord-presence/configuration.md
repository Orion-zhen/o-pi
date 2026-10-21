# Presence 展示配置

## 字段

| 字段 | 含义 |
| --- | --- |
| `enabled` | 会话启动时是否开启 |
| `application_id` | Discord 应用 ID，17–20 位数字 |
| `update_interval_ms` | 发送间隔，默认 5000ms，范围 5000–60000 |
| `retry_interval_ms` | 重试间隔，默认 30000ms，范围 5000–300000 |
| `profile` | 选中的档位，默认 standard |
| `profiles` | 活动模板和计时 |
| `assets` | 图片资源与悬停文本 |

普通对象递归合并，`profiles.<name>.details` 整体替换。未知字段和模板占位符会导致配置错误。

## 档位

| 档位 | 内容 |
| --- | --- |
| minimal | idle、thinking，固定文字，无计时 |
| standard | 全部活动、简化模型名、程序名、工具名和计时 |
| detailed | 在 standard 基础上增加项目名和文件名 |

每个档位包含 details、state 和 show_elapsed。details 决定订阅的活动与第一行文字，state 为第二行，show_elapsed 控制计时。

未订阅的活动只更新内部状态，Discord 保留上一次展示。空 details 表示不发布活动更新。

```json
{
  "profile": "focus",
  "profiles": {
    "focus": {
      "details": {
        "thinking": "规划任务",
        "editing": "修改 {file}"
      },
      "state": "{project} · {model}",
      "show_elapsed": true
    }
  }
}
```

新档位需同时提供三个字段，名称匹配 `^[a-z][a-z0-9_-]{0,31}$`。

## 活动与模板

活动包括 idle、thinking、reading、editing、writing、searching、browsing、shell 和 other_tool。

| 占位符 | 值 |
| --- | --- |
| `{project}` | 工作目录基本名 |
| `{model}` | 简化模型展示名 |
| `{session}` | 会话名，未命名时用项目名 |
| `{file}` | 文件基本名 |
| `{language}` | 文件语言 |
| `{executable}` | Shell 首个有效程序名，无法识别时用 command |
| `{tool}` | 原始工具名 |
| `{label}` | 文件语言或活动标签 |

模板合并空白、清理首尾并限制为 128 个 Unicode 字符。最终少于两个字符时省略字段。

## 图片

图片键对应 application_id 所属应用的 Rich Presence Art Assets。

| 字段 | 用途 |
| --- | --- |
| `assets.large.key` | 大图键，空字符串关闭 |
| `assets.large.text` | 大图悬停模板 |
| `assets.small.text` | 小图悬停模板 |
| `assets.small.default` | 小图默认键 |
| `assets.small.activities` | 按活动选择图片 |
| `assets.small.languages` | 按语言选择图片 |

小图优先级为语言、活动、default。默认按活动发送同名小图，显示取决于 Discord 应用是否上传了对应资源。覆盖某个图标为空字符串可关闭继承值。

语言键支持 c、cpp、css、go、html、java、javascript、json、lua、markdown、python、ruby、rust、shell、sql、toml、typescript、vue、xml、yaml、zig。JSONC 使用 json，JSX 使用 javascript，TSX 使用 typescript。

## 自建 Discord 应用

在 [Developer Portal](https://discord.com/developers/applications) 创建应用，复制公开的应用 ID，上传图片，再覆盖对应字段。Presence 使用应用 ID，无需 Bot Token 或 Client Secret。

```json
{
  "application_id": "123456789012345678",
  "assets": { "large": { "key": "logo", "text": "O Pi" } }
}
```

更换应用后检查继承的小图键是否存在。
