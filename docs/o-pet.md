# o-pet 集成

桌宠程序位于独立仓库 [`Orion-zhen/o-pet`](https://github.com/Orion-zhen/o-pet)。本仓库只保留 Pi 适配器，不读取桌宠仓库的源码、资源或测试夹具。

## 安装桌宠

```bash
git clone git@github.com:Orion-zhen/o-pet.git
cd o-pet
cargo build --release
cargo run --release
```

构建前需要安装当前平台对应的窗口和 WebView 开发依赖。具体要求见桌宠仓库的 README。

## 启用 Pi 适配器

主仓库中的 [`agent/extensions/o-pet.ts`](../agent/extensions/o-pet.ts) 监听 Pi 生命周期和工具事件，并通过本地 JSON Lines IPC 发送状态。桌宠和 Pi 适配器之间没有源码依赖。

默认端点由两个进程分别按平台规则确定。需要覆盖端点时，为两个进程设置相同的 `O_PET_ENDPOINT`：

```bash
export O_PET_ENDPOINT="$XDG_RUNTIME_DIR/o-pet.sock"
```

协议字段和端点规则见 [o-pet README](https://github.com/Orion-zhen/o-pet#ipc-协议)。
