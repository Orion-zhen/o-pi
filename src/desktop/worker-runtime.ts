import { setHostServices } from "../harness/runtime/host-services.ts";
import { openServiceChannel } from "./service-client.ts";
import { createDesktopWebSocket } from "./websocket-client.ts";

export async function initializeDesktopWorker(): Promise<() => void> {
	// forkDesktopWorker 在返回前发送首条消息，仅用于移交服务端口。
	const port = await new Promise<Electron.MessagePortMain>((resolve, reject) => {
		process.parentPort.once("message", ({ ports }: Electron.MessageEvent) => {
			const port = ports[0];
			if (port) resolve(port);
			else reject(new Error("Desktop services missing"));
		});
	});
	// 协调进程复用打包入口但运行于 Node 模式，不能在模块加载时导入 Electron API。
	const { net } = await import("electron");
	// SDK 会记录加载时的 fetch。先加载，再注入，避免 CLI 初始化覆盖宿主网络栈。
	await import("@earendil-works/pi-coding-agent");
	const { open, host } = openServiceChannel(port);
	setHostServices(host);
	globalThis.fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input, init);
	globalThis.WebSocket = createDesktopWebSocket(open);
	return () => port.close();
}
