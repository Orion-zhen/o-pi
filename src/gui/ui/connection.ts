import type { DesktopBridge, GuiAction, GuiConnection, GuiEvent } from "../contract.ts";

declare global {
	interface Window {
		opi?: DesktopBridge;
	}
}

export async function connectGui(onStatus: (status: string) => void): Promise<GuiConnection> {
	if (window.opi) {
		onStatus("已连接");
		return window.opi;
	}
	const token = location.hash.slice(1);
	if (token) {
		const response = await fetch("/api/auth", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
		if (!response.ok) throw new Error("访问密钥无效，请使用 opi-web 启动时打印的完整链接。");
		history.replaceState(null, "", location.pathname);
	}
	let closed = false;
	let socket: WebSocket;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let attempts = 0;
	const listeners = new Set<(event: GuiEvent) => void>();
	const open = () => {
		if (closed) return;
		onStatus("连接中");
		socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/events`);
		socket.onopen = () => {
			attempts = 0;
			onStatus("已连接");
		};
		socket.onmessage = (message: MessageEvent<string>) => {
			const event = JSON.parse(message.data) as GuiEvent;
			for (const listener of listeners) listener(event);
		};
		socket.onclose = () => {
			if (closed) return;
			onStatus("已断开，后台任务不会因此停止");
			if (++attempts <= 6) timer = setTimeout(open, Math.min(1000 * attempts, 10_000));
		};
	};
	open();
	return {
		async send(action: GuiAction) {
			if (socket.readyState !== WebSocket.OPEN) throw new Error("连接尚未恢复，请稍后再试。");
			let response: Response;
			try {
				response = await fetch("/api/action", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(action),
				});
			} catch {
				throw new Error("连接中断。请求可能已执行，请恢复连接并检查会话后再决定是否重新提交。");
			}
			if (!response.ok) throw new Error(await response.text());
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close() {
			closed = true;
			clearTimeout(timer);
			socket.close();
			listeners.clear();
		},
	};
}
