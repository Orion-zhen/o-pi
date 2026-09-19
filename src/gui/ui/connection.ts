import type { DesktopBridge, GuiAction, GuiConnection, GuiEvent, GuiQuery, GuiQueryResults } from "../contract.ts";
import { GuiReceiver, type GuiDelivery } from "../sync.ts";

export type Send = (action: GuiAction) => Promise<boolean>;
export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "closed";
export const connectionLabels: Record<ConnectionStatus, string> = {
	connecting: "连接中", connected: "已连接", disconnected: "已断开，后台任务不会因此停止", closed: "会话已关闭",
};

declare global {
	interface Window { opi?: DesktopBridge }
}

export function connectGui(onStatus: (status: ConnectionStatus) => void): GuiConnection {
	const listeners = new Set<(event: GuiEvent) => void>();
	let clientId = "";
	let selectedId = sessionStorage.getItem("opi.session");
	const receiver = new GuiReceiver();
	let frame: number | undefined;
	let pending: { delivery: GuiDelivery; acknowledge: (id: number) => void }[] = [];
	const receive = (delivery: GuiDelivery, acknowledge: (id: number) => void) => {
		pending.push({ delivery, acknowledge });
		if (frame !== undefined) return;
		frame = requestAnimationFrame(() => {
			frame = undefined;
			const batch = pending;
			pending = [];
			let snapshot: Extract<GuiEvent, { type: "snapshot" }> | undefined;
			for (const { delivery } of batch) for (const event of delivery.events) {
				const value = receiver.accept(event);
				if (value.type === "client") { clientId = value.id; onStatus("connected"); continue; }
				if (value.type === "selected") {
					selectedId = value.session?.id ?? null;
					if (selectedId) sessionStorage.setItem("opi.session", selectedId);
					else sessionStorage.removeItem("opi.session");
				}
				if (value.type === "snapshot") snapshot = value;
				else for (const listener of listeners) listener(value);
			}
			if (snapshot) for (const listener of listeners) listener(snapshot);
			const last = batch.at(-1);
			if (last) last.acknowledge(last.delivery.id);
		});
	};
	const cancelFrame = () => { if (frame !== undefined) cancelAnimationFrame(frame); frame = undefined; pending = []; };
	const subscribe: GuiConnection["subscribe"] = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
	const desktop = window.opi;
	if (desktop) {
		onStatus("connected");
		const unsubscribe = desktop.subscribe((delivery) => receive(delivery, desktop.acknowledge));
		return {
			send: desktop.send, query: desktop.query, subscribe,
			close() { cancelFrame(); unsubscribe(); desktop.close(); listeners.clear(); },
		};
	}
	let closed = false;
	let socket: WebSocket;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let attempts = 0;
	const open = () => {
		if (closed) return;
		onStatus("connecting");
		const search = selectedId ? `?session=${encodeURIComponent(selectedId)}` : "";
		const client = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/events${search}`);
		socket = client;
		client.onopen = () => { attempts = 0; };
		client.onmessage = (message: MessageEvent<string>) => receive(JSON.parse(message.data) as GuiDelivery, (id) => {
			if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ ack: id }));
		});
		client.onclose = () => {
			cancelFrame();
			clientId = "";
			if (closed) return;
			onStatus("disconnected");
			if (++attempts <= 6) timer = setTimeout(open, Math.min(1000 * attempts, 10_000));
		};
	};
	const post = async (kind: "action" | "query", value: unknown): Promise<Response> => {
		if (socket.readyState !== WebSocket.OPEN || !clientId) throw new Error("连接尚未恢复，请稍后再试。");
		let response: Response;
		try {
			response = await fetch(`/api/${kind}`, {
				method: "POST", headers: { "Content-Type": "application/json", "X-Opi-Client": clientId }, body: JSON.stringify(value),
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
		async send(value, sessionId) { await post("action", { value, sessionId }); },
		async query<Q extends GuiQuery>(query: Q, sessionId: string | null): Promise<GuiQueryResults[Q["query"]]> {
			const value: unknown = await (await post("query", { value: query, sessionId })).json();
			return value as GuiQueryResults[Q["query"]];
		},
		subscribe,
		close() { closed = true; clearTimeout(timer); cancelFrame(); socket.close(); listeners.clear(); },
	};
}
