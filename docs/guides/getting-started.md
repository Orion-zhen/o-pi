# 安装与启动

## 准备

构建需要 Git 和 Bun >= 1.4.0。首次安装依赖会下载 Electron。

```bash
git clone https://github.com/Orion-zhen/o-pi.git
cd o-pi
bun install --no-save
```

仓库可放在任意目录。运行时按功能使用 Bash、Git 和语言服务器等外部程序。

## TUI

```bash
bun run build:tui
./dist/tui/opi
```

将产物放入 PATH 后可直接运行 `opi`。Windows 产物名为 `opi.exe`。

进入项目目录后启动。用 `/login` 配置认证，用 `/model` 选择模型。自定义模型服务见[配置指南](configuration.md)。

## Web

```bash
bun run build:web
./dist/web/opi-web --cwd /path/to/project --host 127.0.0.1
```

打开启动输出中的地址。Windows 产物名为 `opi-web.exe`。其他设备访问见[远程访问](remote-access.md)。

## Desktop

先构建应用目录并预览：

```bash
bun run build:desktop --dir
bun run desktop
```

制作当前平台的安装包：

```bash
bun run build:desktop
```

产物位于 `dist/desktop/release/`：

| 平台 | 文件 |
| --- | --- |
| Linux | `opi-desktop.AppImage` |
| macOS | `opi-desktop.dmg` |
| Windows | `opi-desktop.exe`，NSIS 安装程序 |

构建使用当前系统和 CPU 架构。桌面包未配置签名、公证和自动更新。

## 配置与会话

三端沿用 Pi 的认证、模型和会话目录，默认是 `~/.pi/agent/`。GUI 可以直接打开 TUI 的历史会话。Web 读取服务端电脑的数据。

TUI 和 Web 是包含 Bun 运行时的单文件程序，Desktop 包含 Electron。运行产物无需另外安装 Node.js 或 Bun。

## 从源码运行

```bash
bun run dev:tui
bun run dev:web
```

`dev:web` 先构建前端，再启动 Web 后端。前端修改后重新运行该命令。

`bun run build` 构建全部应用。打包资源和构建选项见 [构建 Reference](../reference/runtime/build.md)。

## 升级

更新源码后重新安装依赖并构建需要的应用：

```bash
git pull
rm -f bun.lock
bun install --no-save --no-cache
bun run build:tui
```

依赖跟随 `latest`，仓库不提交锁文件。验证产物后再替换原程序，运行中的实例需要重启。验证命令见[测试](../reference/runtime/testing.md)。

opi 沿用 Pi 的版本和更新提示。升级通过重新构建完成。Pi 的 `install`、`remove`、`uninstall`、`update`、`list`、`config` 包管理命令在 opi 中不可用。已有 settings 中的 `packages` 应移除或改为直接配置本地资源。
