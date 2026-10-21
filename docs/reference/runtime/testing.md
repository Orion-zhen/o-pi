# 测试

测试规则见根目录 [AGENTS.md](../../../AGENTS.md)。构建使用 Bun，Vitest 需要 Node.js >= 22.19.0。

## 类型与业务测试

```bash
bun run typecheck
bun run vitest run tests/harness/<模块>
bun run test tests/cli tests/rpc
```

`bun run test` 先构建 TUI，再运行 Vitest。只验证源码时直接运行定向 Vitest 用例，避免重复构建。

| 目录 | 范围 |
| --- | --- |
| `tests/harness/` | 业务模块和 SDK 工具流程 |
| `tests/tui/` | 终端界面和呈现 |
| `tests/cli/`、`tests/rpc/` | 真实入口和协议 |
| `tests/gui/` | GUI 宿主、页面与打包测试 |
| `tests/helpers/` | 共享测试辅助代码 |

模型流程使用本地 HTTP 服务，配置和认证通过临时 HOME 隔离。

## Web 界面

需要验证页面交互或打包资源时，选择对应文件运行无头测试：

```bash
bun run test:gui tests/gui/preferences.e2e.ts --project=desktop
```

此处 `desktop` 是浏览器大屏视口，`phone` 是窄屏视口。`test:gui` 只构建 Web，使用已安装的 Playwright Chromium。窄屏测试覆盖布局，触摸与真机兼容需要另行验证。

## Electron

`test:desktop` 构建桌面应用目录并运行原生用例，会启动可见窗口。运行前取得用户同意，并使用隔离显示环境。Linux 示例：

```bash
xvfb-run -a bun run test:desktop tests/gui/desktop-protocol.e2e.ts
```

仅检查打包后端的 Node 模式启动与退出时，可选择不创建窗口的用例：

```bash
bun run test:desktop tests/gui/desktop-runtime.integration.ts
```

测试进程设置 `OPI_NO_NOTIFICATIONS=1`，关闭系统通知并保留审批交互。通知单元测试模拟系统 API。

## 独立产物

Linux 可通过 Podman 检查无 Node/Bun、无仓库挂载时的二进制运行：

```bash
OPI_CONTAINER_IMAGE=docker.io/library/eclipse-temurin:17-jdk bun run test tests/cli/container.test.ts
```

容器挂载临时测试目录，通过宿主网络访问本地模型服务。镜像需要可运行产物的 glibc，且不预装 Node/Bun。

性能测量见[基准](benchmark.md)。
