import { net, type MessagePortMain } from "electron";
import type { SocketCommand, SocketOptions } from "./services-contract.ts";

/** Chromium 保管连接，消息通道关闭时释放连接和发送进度计时器。 */
export function serveWebSocket(port: MessagePortMain, url: string, options: SocketOptions): () => void {
	// net.WebSocket 的声明遗漏了 Electron 扩展的构造参数。
	const Socket = net.WebSocket as typeof Electron.WebSocket;
	const socket = new Socket(url, options);
	socket.binaryType = "arraybuffer";
	let pendingBytes = 0;
	let timer: NodeJS.Timeout | undefined;
	const drain = () => {
		if (socket.bufferedAmount !== 0) return;
		port.postMessage({ kind: "drain", bytes: pendingBytes });
		pendingBytes = 0;
		clearInterval(timer);
		timer = undefined;
	};
	socket.onopen = () => port.postMessage({ kind: "open", protocol: socket.protocol, extensions: socket.extensions });
	socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => port.postMessage({ kind: "message", data: event.data });
	socket.onerror = () => port.postMessage({ kind: "error", message: "WebSocket connection failed" });
	socket.onclose = (event: CloseEvent) => {
		clearInterval(timer);
		port.postMessage({ kind: "close", code: event.code, reason: event.reason, wasClean: event.wasClean });
		port.close();
	};
	port.on("message", ({ data }: { data: SocketCommand }) => {
		try {
			if (data.kind === "close") socket.close(data.code, data.reason);
			else {
				socket.send(data.data);
				pendingBytes += data.bytes;
				drain();
				if (pendingBytes > 0) timer ??= setInterval(drain, 20);
			}
		} catch (error) {
			port.postMessage({ kind: "error", message: String(error) });
			socket.close();
		}
	});
	port.start();
	return () => { clearInterval(timer); socket.close(); port.close(); };
}
