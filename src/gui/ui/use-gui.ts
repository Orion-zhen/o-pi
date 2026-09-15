import { useCallback, useEffect, useRef, useState } from "react";
import type { GuiConnection, GuiDialog, GuiEvent, GuiNotice, GuiSnapshot } from "../contract.ts";
import { connectGui } from "./connection.ts";
import type { Send } from "./dialog.tsx";
import type { PanelData } from "./panels.tsx";

/** 只维护界面状态。重连使用后端快照，不重放操作。 */
export function useGui() {
	const [snapshot, setSnapshot] = useState<GuiSnapshot>();
	const [dialogs, setDialogs] = useState<GuiDialog[]>([]);
	const [notices, setNotices] = useState<GuiNotice[]>([]);
	const [status, setStatus] = useState("连接中");
	const [error, setError] = useState("");
	const [panel, setPanel] = useState<PanelData>();
	const [config, setConfig] = useState<Extract<GuiEvent, { type: "config" }>>();
	const [auth, setAuth] = useState<Extract<GuiEvent, { type: "auth" }>["value"]>();
	const [draft, setDraft] = useState("");
	const [revision, setRevision] = useState(0);
	const [fileChoices, setFileChoices] = useState<string[]>([]);
	const [completions, setCompletions] = useState<Extract<GuiEvent, { type: "completions" }>>();
	const connection = useRef<GuiConnection | undefined>(undefined);
	const editor = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		let active = true;
		let client: GuiConnection | undefined;
		let unsubscribe: (() => void) | undefined;
		void connectGui((status) => {
			if (active) setStatus(status);
		})
			.then((value) => {
				if (!active) {
					value.close();
					return;
				}
				client = value;
				connection.current = value;
				unsubscribe = value.subscribe((event) => {
					if (!active) return;
					switch (event.type) {
						case "snapshot":
							setSnapshot(event.value);
							setDialogs(event.value.dialogs);
							setNotices(event.value.notices);
							break;
						case "dialogs":
							setDialogs(event.value);
							break;
						case "notice":
							setNotices((current) =>
								[...current.filter((notice) => notice.id !== event.value.id), event.value].slice(-100),
							);
							break;
						case "panel":
							setPanel({ title: event.title, value: event.value });
							break;
						case "editor":
							setDraft(event.text);
							editor.current?.focus();
							break;
						case "files":
							setFileChoices(event.paths);
							break;
						case "completions":
							setCompletions(event);
							break;
						case "config":
							setConfig(event);
							break;
						case "auth":
							setAuth(event.value);
							break;
						case "download": {
							const url = URL.createObjectURL(new Blob([event.content], { type: event.mimeType }));
							const link = document.createElement("a");
							link.href = url;
							link.download = event.name;
							link.click();
							setTimeout(() => URL.revokeObjectURL(url), 1000);
							break;
						}
						case "close":
							value.close();
							setStatus("会话已关闭");
							break;
					}
				});
			})
			.catch((error: unknown) => {
				if (active) setError(error instanceof Error ? error.message : String(error));
			});
		return () => {
			active = false;
			unsubscribe?.();
			client?.close();
			connection.current = undefined;
		};
	}, [revision]);

	const send: Send = useCallback(async (action) => {
		if (!connection.current) {
			setError("连接尚未就绪。");
			return false;
		}
		try {
			await connection.current.send(action);
			return true;
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
			return false;
		}
	}, []);
	useEffect(() => {
		const timer = setTimeout(() => {
			if (status === "已连接") {
				void send({ action: "draft", text: draft });
				if (/^\/\S+\s/.test(draft)) void send({ action: "complete", text: draft });
			}
		}, 250);
		return () => clearTimeout(timer);
	}, [draft, send, status]);
	useEffect(() => {
		setPanel(undefined);
		setConfig(undefined);
	}, [snapshot?.sessionId]);
	const running = Boolean(
		snapshot?.streaming || snapshot?.compacting || snapshot?.bashRunning || snapshot?.commandRunning,
	);
	const command = (text: string) => {
		void send({ action: "prompt", text, images: [], behavior: "followUp" });
	};
	return {
		snapshot,
		dialogs,
		notices,
		status,
		error,
		setError,
		panel,
		setPanel,
		config,
		setConfig,
		auth,
		setAuth,
		draft,
		setDraft,
		fileChoices,
		setFileChoices,
		completions,
		editor,
		send,
		command,
		running,
		reconnect: () => setRevision((value) => value + 1),
	};
}
export type GuiView = ReturnType<typeof useGui>;
