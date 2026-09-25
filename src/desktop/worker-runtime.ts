import { net } from "electron";
import { setHostServices } from "../harness/runtime/host-services.ts";
import { openServiceChannel } from "./service-client.ts";
import { createDesktopWebSocket } from "./websocket-client.ts";

export async function initializeDesktopWorker(): Promise<() => void> {
	const port = await new Promise<Electron.MessagePortMain>((resolve) => {
		const ready = ({ data, ports }: Electron.MessageEvent) => {
			if (typeof data !== "object" || data === null || !("kind" in data) || data.kind !== "desktop-services") return;
			const port = ports[0];
			if (!port) throw new Error("Desktop services missing");
			process.parentPort.removeListener("message", ready);
			resolve(port);
		};
		process.parentPort.on("message", ready);
	});
	// SDK 会记录加载时的 fetch。先加载，再注入，避免 CLI 初始化覆盖宿主网络栈。
	await import("@earendil-works/pi-coding-agent");
	const { open, host } = openServiceChannel(port);
	setHostServices(host);
	globalThis.fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input, init);
	globalThis.WebSocket = createDesktopWebSocket(open);
	return () => port.close();
}
