import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { GuiConnection } from "../../shared/protocol/connection.ts";
import type { GuiEvent } from "../../shared/protocol/events.ts";
import { connectGui, type ConnectionStatus } from "./connection.ts";
import { showBrowserNotification } from "./notifications.ts";

export function useConnection(receive: (event: GuiEvent) => void) {
	const onReceive = useEffectEvent(receive);
	const connection = useRef<GuiConnection | undefined>(undefined);
	const [status, setStatus] = useState<ConnectionStatus>("connecting");
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		const client = connectGui(setStatus);
		connection.current = client;
		const unsubscribe = client.subscribe((event) => {
			if (event.type === "close") { client.close(); setStatus("closed"); }
			else if (event.type === "notification") showBrowserNotification(event.value, () => {
				void client.send({ action: "openSession", id: event.value.sessionId }, null)
					.catch((error: unknown) => onReceive({ type: "error", message: String(error) }));
			});
			else if (event.type === "download") download(event);
			else onReceive(event);
		});
		return () => { unsubscribe(); client.close(); connection.current = undefined; };
	}, [revision]);
	const current = useCallback(() => {
		if (!connection.current) throw new Error("连接尚未就绪。");
		return connection.current;
	}, []);
	const attend = useCallback<GuiConnection["attend"]>((sessionId) => current().attend(sessionId), [current]);
	const send = useCallback<GuiConnection["send"]>(async (action, sessionId) => current().send(action, sessionId), [current]);
	const query = useCallback<GuiConnection["query"]>(async (query, sessionId) => current().query(query, sessionId), [current]);
	const reconnect = useCallback(() => setRevision((value) => value + 1), []);
	return { status, connected: status === "connected", attend, send, query, reconnect };
}

function download(event: Extract<GuiEvent, { type: "download" }>): void {
	const url = URL.createObjectURL(new Blob([event.content], { type: event.mimeType }));
	const link = document.createElement("a");
	link.href = url; link.download = event.name; link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
