# o-pet

[o-pet](https://github.com/Orion-zhen/o-pet) 是独立的桌面宠物应用。opi 适配器监听会话与工具事件，通过本地 JSON Lines IPC 发送状态。

## 启动

按 o-pet 仓库说明安装平台依赖并运行桌宠：

```bash
git clone git@github.com:Orion-zhen/o-pet.git
cd o-pet
cargo run --release
```

默认端点由两端按平台规则确定。需要指定时，为两个进程设置相同的 `O_PET_ENDPOINT`，例如 Linux：

```bash
export O_PET_ENDPOINT="$XDG_RUNTIME_DIR/o-pet.sock"
```

协议与端点规则见 [o-pet README](https://github.com/Orion-zhen/o-pet#ipc-协议)。适配入口为 `src/harness/extensions/o-pet.ts`，客户端位于 `src/harness/o-pet/`。
