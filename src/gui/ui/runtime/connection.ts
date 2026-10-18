import type { DesktopBridge, GuiAction, GuiConnection, GuiControl, GuiEvent, GuiQuery, GuiQueryResults } from "../../contract.ts";
import { GuiReceiver, type GuiDelivery, type GuiFrame } from "../../sync.ts";
import { diagnosticContext } from "./diagnostics.ts";
import { notificationDestination, NOTIFICATION_PERMISSION_CHANGED } from "./browser-notifications.ts";

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
	let pending: { delivery: GuiFrame; acknowledge: (id: number) => void }[] = [];
	const receive = (delivery: GuiDelivery, acknowledge: (id: number) => void) => {
		if (delivery.kind === "notification") {
			for (const listener of listeners) listener({ type: "notification", value: delivery.value });
			return;
		}
		pending.push({ delivery, acknowledge });
		if (frame !== undefined) return;
		frame = requestAnimationFrame(() => {
			frame = undefined;
			const batch = pending;
			pending = [];
			let snapshot: Extract<GuiEvent, { type: "snapshot" }> | undefined;
			for (const { delivery } of batch) for (const event of delivery.events) {
				diagnosticContext({ deliveryId: delivery.id, lastEvent: event.type });
				const value = receiver.accept(event);
				if (value.type === "snapshot") diagnosticContext({ sessionId: value.value?.sessionId ?? null, running: value.value?.running ?? null });
				if (value.type === "client") { clientId = value.id; onStatus("connected"); continue; }
				if (value.type === "selected") {
					selectedId = value.session?.id ?? null;
					diagnosticContext({ sessionId: selectedId, running: null });
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
			attend: desktop.attend,
			send: (action, sessionId) => { diagnosticContext({ lastAction: action.action }); return desktop.send(action, sessionId); },
			query: desktop.query, subscribe,
			close() { cancelFrame(); unsubscribe(); desktop.close(); listeners.clear(); },
		};
	}
	let closed = false;
	let socket: WebSocket;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let attempts = 0;
	let viewedSession: string | null = null;
	const control = (value: GuiControl) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
	};
	const reportAttention = () => control({ kind: "attention", value: {
		sessionId: viewedSession,
		focused: document.visibilityState === "visible" && document.hasFocus(),
		destination: notificationDestination(),
	} });
	const attentionEvents = ["focus", "blur", NOTIFICATION_PERMISSION_CHANGED] as const;
	for (const event of attentionEvents) window.addEventListener(event, reportAttention);
	document.addEventListener("visibilitychange", reportAttention);
	const open = () => {
		if (closed) return;
		onStatus("connecting");
		const search = selectedId ? `?session=${encodeURIComponent(selectedId)}` : "";
		const client = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/events${search}`);
		socket = client;
		client.onopen = () => { attempts = 0; reportAttention(); };
		client.onmessage = (message: MessageEvent<string>) => receive(JSON.parse(message.data) as GuiDelivery, (id) => {
			if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ kind: "ack", id } satisfies GuiControl));
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
		attend(sessionId) { viewedSession = sessionId; reportAttention(); },
		async send(value, sessionId) { diagnosticContext({ lastAction: value.action }); await post("action", { value, sessionId }); },
		async query<Q extends GuiQuery>(query: Q, sessionId: string | null): Promise<GuiQueryResults[Q["query"]]> {
			const value: unknown = await (await post("query", { value: query, sessionId })).json();
			return value as GuiQueryResults[Q["query"]];
		},
		subscribe,
		close() {
			closed = true;
			for (const event of attentionEvents) window.removeEventListener(event, reportAttention);
			document.removeEventListener("visibilitychange", reportAttention);
			clearTimeout(timer); cancelFrame(); socket.close(); listeners.clear();
		},
	};
}
