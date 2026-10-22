# GUI 配置

默认文件为 [`agent/defaults/gui.jsonc`](../../../agent/defaults/gui.jsonc)，用户文件为 `~/.pi/agent/configs/gui.jsonc`。用户目录跟随 `PI_CODING_AGENT_DIR`，`PI_GUI_CONFIG` 可指定单独文件。GUI 配置使用默认层和用户层。

## 编辑与保存

设置页将外观、对话与输入、模型服务、工具与代码、网络与网页、子代理、权限与安全、连接与集成、存储管理和终端界面分组展示。

表单修改保存在草稿中。切换分类保留草稿，统一点击“保存”写文件。“放弃修改”撤销草稿，重置操作删除相应覆盖项。表单保留 JSONC 注释，保存时校验字段并检查外部修改。

主题色和材质控件提供预览。滑块释放、HEX 确认和输入失焦将值提交到草稿，仍需点击设置页“保存”。

外观和交互保存后应用到连接同一宿主的页面。桌面 Web 监听配置重启后生效。模块配置在下一次读取时生效，已经加载的组件可能需要 `/reload` 或重启。

## 基本字段

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `theme` | `"system"` | `system`、`light` 或 `dark` |
| `themeColor` | `"#007AFF"` | `#RRGGBB` 主题色 |
| `fonts.ui` | 见默认文件 | 界面字体链 |
| `fonts.code` | 见默认文件 | 代码字体链 |
| `fontSizes.ui` | `14` | 界面字号 |
| `fontSizes.chat` | `16` | 对话字号 |
| `fontSizes.code` | `14` | 代码字号 |
| `sendShortcut` | `"mod-enter"` | Ctrl/⌘+Enter 发送，也可设为 `enter` |
| `openFileLinksExternally` | `false` | Desktop 使用系统默认应用打开聊天中的文件链接 |
| `materials.enabled` | `true` | 页面磨砂材质 |
| `materials.desktop` | `true` | Desktop 窗口背景透明 |
| `desktopWeb.enabled` | `false` | 启用桌面 Web 服务 |
| `desktopWeb.host` | `"127.0.0.1"` | 监听地址 |
| `desktopWeb.port` | `19198` | 0–65535，0 自动分配 |
| `sessionCache.idleLimit` | `3` | 超时且可回收实例的保留数量 |
| `sessionCache.idleMs` | `60000` | 空闲门槛和扫描间隔，毫秒 |

字号范围为 8–48，支持小数。选择 Enter 发送时，Shift+Enter 换行，Ctrl/⌘+Enter 仍可发送。输入法组字和补全优先处理键盘事件。

“对话与输入”中的“使用外部应用打开文件链接”在 Web 和 Desktop 均可设置，保存后仅在 Desktop 生效。文件须位于当前工作区内，符号链接不能指向工作区外。关闭时、使用 Web 时或点击文件树时仍使用右侧预览。

## 字体

每项是一个字体族名称，按数组顺序匹配：

```json
{
  "fonts": {
    "ui": ["Inter", "Noto Sans SC", "Apple Color Emoji"],
    "code": ["JetBrains Mono", "Noto Sans Mono CJK SC"]
  }
}
```

界面字体末尾追加 `system-ui, sans-serif`，代码字体末尾追加 `ui-monospace, monospace`。空数组使用系统默认。

“读取本机字体”由用户主动触发。Desktop 读取本机字体，Web 读取访问设备字体，需要浏览器支持、安全上下文和授权。也可以手动填写名称。

## 材质

每个区域可以覆盖浅色不透明度 `opacity`、深色不透明度 `darkOpacity`、模糊 `blur` 和饱和度 `saturation`。

| 区域 | 用途 | 浅色 % | 深色 % | 模糊 px | 饱和度 % |
| --- | --- | ---: | ---: | ---: | ---: |
| `canvas` | 聊天画布与输入器外围 | 88 | 92 | 32 | 100 |
| `sidebar` | 左栏 | 72 | 86 | 24 | 110 |
| `toolbar` | 顶栏 | 80 | 90 | 24 | 110 |
| `inspector` | 会话信息栏 | 86 | 90 | 24 | 110 |
| `composer` | 输入器 | 88 | 92 | 20 | 110 |
| `floating` | 菜单与浮层 | 86 | 86 | 24 | 110 |
| `dialog` | 弹窗 | 94 | 96 | 32 | 110 |
| `overlay` | 遮罩 | 32 | 32 | 4 | 100 |

不透明度范围 0–100，模糊 0–64，饱和度 0–200。100% 不透明表示完全遮住背景，100% 饱和度保留原色。

macOS 使用 vibrancy，Windows 11 22H2 起使用 Acrylic，Linux 的窗口背景模糊由桌面合成器提供。CSS 参数控制页面材质。

macOS 开启桌面透明时，应用停用页面背景滤镜以避免闪烁，菜单和弹窗使用不透明底色。设置页隐藏此模式下无效的参数，关闭桌面透明后恢复。

系统减少透明度、增强对比度和强制颜色模式优先于材质配置。

## 客户端布局

侧栏、正文和文件区的拖拽尺寸保存到客户端本地状态。Desktop 与各浏览器分别保存。默认左栏占 20%，右栏占聊天工作区的 34%，正文最大宽度为 100ch，左栏会话区占可分配高度的 55%。

双击恢复对应尺寸，方向键微调，Home 或 Enter 重置，Esc 取消拖动。实际尺寸受窗口空间约束。

## 宿主设置

Desktop Web 的使用步骤见[远程访问](../../guides/remote-access.md)。实例回收规则见[会话](sessions.md#实例回收)。`sessionCache` 通过 JSON 编辑，保存后更新宿主策略。
