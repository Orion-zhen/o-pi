# GUI MVP

Desktop 和 `opi-web` 共用 React 界面及 SDK 装配。Desktop 在 Electron utility process 中直接调用 `pi-coding-agent`，不启动 Pi CLI、TUI 或 stdio RPC。Web 后端使用 Bun，浏览器通过带鉴权的 HTTP 操作和 WebSocket 状态订阅连接。

## 启动

需要 Bun >= 1.4.0。首次安装会下载 Electron。

```sh
bun install --no-save

# 独立 Web 可执行文件
bun run build:web
./dist/opi-web --cwd /path/to/project

# 只构建桌面应用目录，直接预览
bun scripts/build-desktop.mjs --dir
bun run desktop

# 当前系统的桌面分发包
bun run build:desktop
```

Windows 的 Web 产物为 `dist/opi-web.exe`。Desktop 分发文件位于 `dist/desktop/release/`，Linux 为 AppImage，macOS 为 DMG，Windows 为 NSIS 安装程序。MVP 未配置签名、macOS 公证或自动更新。三平台分别构建，不把 Linux 构建成功视为其他平台已经验证。

`bun run dev:web` 构建前端后从源码启动 Web 服务，不提供热更新。

两个分发产物都包含 SDK 和所需运行资源，不要求用户安装 Bun、Node.js 或仓库依赖。Bash、Git、语言服务器等外部工具仍按使用场景由用户安装。Desktop 不需要另外安装 `opi-web` 或 `opi`。

沿用 `~/.pi/agent` 的配置、认证和会话。Web 内嵌资源使用与 CLI 相同的内容寻址缓存。输入历史与 TUI 共用 `~/.pi/cache/user-history/history.jsonl`，按工作目录隔离。

## Web 访问与手机

默认监听 `127.0.0.1:3141`。启动时打印带访问密钥的完整链接。浏览器首次访问将密钥换成 HttpOnly、SameSite=Strict Cookie，并移除地址栏中的密钥。

访问密钥允许控制后端电脑上的文件和进程，不要分享给其他人。浏览器刷新、断网或手机锁屏不结束后台任务。重连后读取 SDK 当前状态和尚未处理的审批，不自动重发操作。

局域网访问必须配置 TLS：

```sh
./dist/opi-web --cwd /path/to/project --host 0.0.0.0 --port 3141 \
  --cert /path/to/cert.pem --key /path/to/key.pem
```

手机使用电脑的局域网 IP 或证书对应的域名替换链接中的 `0.0.0.0`。证书需要被手机信任，并匹配访问地址。当前没有可信反向代理配置，不接受代理转发的协议头。

当前是单用户、单活动会话的宿主。多个页面操作同一会话，审批响应只消费一次。不是多用户服务，也不是每个浏览器各有一份独立会话。

## 功能

| 功能 | MVP 入口 |
| --- | --- |
| 对话、思考、工具参数、结果、执行中输出、图片 | 主对话区，内容可折叠 |
| 停止、steer、follow-up、清空队列 | 输入区及队列区域 |
| 新建、恢复、重命名、分支、树导航与标签 | 侧栏、会话树、`/name` |
| JSONL 导入、JSONL/HTML 导出 | 侧栏，Desktop 使用原生保存对话框 |
| 模型、思考级别、模型范围 | 输入区、`/model`、`/thinking`、`/scoped-models` |
| API Key、OAuth 登录和退出 | 认证面板，使用 SDK 的登录交互 |
| 自动压缩、重试、队列和图片设置 | 设置面板，完整设置可编辑 `settings.json` |
| 手动压缩、资源重载 | `/compact`、`/reload` |
| 项目信任、工具审批、确认、选择、输入、多行编辑 | 图形弹窗，不默认批准 |
| 工具启停、分支恢复、保存用户默认 | `/tools` |
| 系统提示词、会话统计、用量、遥测 | `/system`、`/stats`、`/usage`、`/telemetry`，展示结构化数据 |
| 技能、提示词模板、其他业务扩展命令 | SDK `prompt()` 分发，命令与参数补全 |
| 子代理 | `subagent` 工具、`/agents`、`/run`，图形进度与取消 |
| 上下文裁剪、LSP、Presence、o-pet | 原有 harness 业务与命令 |
| 用户 Shell | `!`、`!!`，执行语义与 SDK/TUI 一致 |
| 文件引用、上传、粘贴图片 | `@路径`、附件按钮、剪贴板 |
| 输入历史 | 输入区下拉列表，与 TUI 共用持久记录 |

发送使用按钮或 `Ctrl/⌘ + Enter`。`Enter` 保留换行。输入 `@路径前缀` 后按 `Tab` 获取后端目录候选。上传单文件暂限 3 MB，最多 8 张图片。后端 `@` 附件暂限 8 MiB，二进制附件提供路径供文件工具读取。

`!`/`!!` 是用户直接执行 Shell，不走模型工具的 Approval Gate，与现有 TUI 行为一致。

## 实现边界

- `src/gui/host/` 创建和绑定 SDK runtime，处理图形交互、生命周期及输入校验。会话、队列、压缩、重试和工具执行仍由 SDK 管理。
- `src/gui/contract.ts` 只定义跨边界操作参数与可序列化的界面数据，不提供新的 Agent 或 Session 门面。
- `src/gui/ui/` 不导入 Node、Bun 或 SDK 的运行时代码。消息中的 HTML 不执行，远程图片不自动加载。
- `src/desktop/` 提供隔离的 Electron 宿主、限定的 preload 桥接、目录选择和文件保存。渲染进程没有 Node 权限。
- `src/web/` 提供静态资源、鉴权、来源校验和状态订阅。监听非回环地址时必须启用 TLS。
- `harness` 的呈现器由宿主注入。TUI 呈现器仍只在 TUI 模式使用，GUI 不加载它们。

当前 SDK 没有 `gui` 模式标识。GUI 绑定 `mode: "print"` 和真实 `uiContext`，SDK 据此提供 `hasUI: true`。这不调用 `runPrintMode()`，也不使用 RPC。扩展应通过 `hasUI` 判断标准对话能力，通过 `mode === "tui"` 判断终端组件能力。

支持外部 TS/JS 扩展的工具、命令和标准对话接口。不支持把 `ctx.ui.custom()`、终端编辑器、终端输入监听或终端组件工厂转换为网页。TUI 动效、主题、布局和快捷键不逐项复刻。统计、遥测和复杂工具详情暂以简单面板展示，不保证与 TUI 相同的视觉呈现。

MVP 不承诺任意外部扩展都能在 GUI 使用，尤其是直接依赖终端模式判断、同步编辑器状态或终端组件的扩展。也不承诺任务在应用退出、服务进程重启后继续执行。

## 验证

```sh
bun run typecheck
./node_modules/.bin/vitest run tests/gui
bun run test:gui
```

GUI 测试复用项目已有的 Electron，Playwright 只作自动化驱动，不需要下载独立浏览器。Linux 需要显示环境，也可使用已安装的 `xvfb-run -a bun run test:gui`。缺少运行环境时先报告，不自动下载安装。测试使用隔离 HOME 和本地模型 HTTP 服务，不读取个人认证，不调用付费模型。

覆盖真实 SDK 文件回路、审批拒绝与重连、会话恢复、Shell、结构化面板、项目扩展信任、配置并发修改、HTTP 鉴权及来源校验。GUI 测试用隔离的 Electron 窗口访问独立 `opi-web`，并把桌面应用目录复制到仓库外启动 Electron，验证图片处理、代码解析 worker、外部扩展、标准输入弹窗和导出。手机布局仅用 Electron 窄屏验证，不包含触摸模拟，不等同于真实 iOS Safari 或 Android 实机验证。
