import type { DesktopBridge, GuiAction, GuiConnection, GuiEvent, GuiQuery, GuiQueryResults } from "../contract.ts";

export type Send = (action: GuiAction) => Promise<boolean>;
export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "closed";
export const connectionLabels: Record<ConnectionStatus, string> = {
	connecting: "连接中", connected: "已连接", disconnected: "已断开，后台任务不会因此停止", closed: "会话已关闭",
};

declare global {
	interface Window { opi?: DesktopBridge }
}

export function connectGui(onStatus: (status: ConnectionStatus) => void): GuiConnection {
	if (window.opi) {
		onStatus("connected");
		return window.opi;
	}
	let closed = false;
	let socket: WebSocket;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let attempts = 0;
	const listeners = new Set<(event: GuiEvent) => void>();
	const open = () => {
		if (closed) return;
		onStatus("connecting");
		socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/events`);
		socket.onopen = () => { attempts = 0; onStatus("connected"); };
		socket.onmessage = (message: MessageEvent<string>) => {
			const event = JSON.parse(message.data) as GuiEvent;
			for (const listener of listeners) listener(event);
		};
		socket.onclose = () => {
			if (closed) return;
			onStatus("disconnected");
			if (++attempts <= 6) timer = setTimeout(open, Math.min(1000 * attempts, 10_000));
		};
	};
	const post = async (kind: "action" | "query", value: unknown): Promise<Response> => {
		if (socket.readyState !== WebSocket.OPEN) throw new Error("连接尚未恢复，请稍后再试。");
		let response: Response;
		try {
			response = await fetch(`/api/${kind}`, {
				method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
			});
		} catch {
			throw new Error(kind === "query" ? "查询连接中断，请恢复连接后重试。"
				: "连接中断。请求可能已执行，请恢复连接并检查会话后再决定是否重新提交。");
		}
		if (!response.ok) throw new Error(await response.text());
		return response;
	};
	open();
	return {
		async send(action) { await post("action", action); },
		async query<Q extends GuiQuery>(query: Q): Promise<GuiQueryResults[Q["query"]]> {
			const value: unknown = await (await post("query", query)).json();
			return value as GuiQueryResults[Q["query"]];
		},
		subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
		close() {
			closed = true;
			clearTimeout(timer);
			socket.close();
			listeners.clear();
		},
	};
}
