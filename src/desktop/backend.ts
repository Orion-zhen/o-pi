import path from "node:path";
import { directory } from "./environment.ts";
import { decodeGuiRequest } from "../gui/host/request.ts";
import type { BackendCommand, BackendMessage, BackendRequest } from "./backend-contract.ts";

await import("../harness/runtime/environment.ts");

const closeServices = process.type === "utility"
	? await (await import("./worker-runtime.ts")).initializeDesktopWorker() : undefined;

const { runChildProcess } = await import("../harness/runtime/invocation.ts");
if (!(await runChildProcess())) {
	const [{ GuiHost }, { readGuiConfig }, { startWebServer }] = await Promise.all([
		import("../gui/host/host.ts"), import("../gui/host/preferences.ts"), import("../web/server.ts"),
	]);
	const gui = new GuiHost();
	const client = gui.createClient();
	const web = (async () => {
		const config = await readGuiConfig();
		if (config.state === "error") throw new Error(config.message);
		const { enabled, host, port } = config.value.desktopWeb;
		if (!enabled) return;
		const server = await startWebServer(gui, { host, port, assets: path.join(directory, "ui") });
		console.log(`opi-desktop web: ${server.url}/`);
		return server;
	})().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Desktop Web 启动失败: ${message}`);
		process.parentPort.postMessage({ kind: "webError", message } satisfies BackendMessage);
	});
	async function dispose(): Promise<void> {
		const server = await web;
		try { await server?.close(); }
		finally { await gui.dispose(); }
	}
	let latestUser: { sessionId: string; timestamp: number } | undefined;
	client.subscribe((event) => {
		if (event.type === "selected") latestUser = undefined;
		if (event.type !== "snapshot" || !event.value) return;
		const user = event.value.entries.flatMap((entry) => entry.messages).findLast((message) => message.role === "user");
		if (!user || user.role !== "user") return;
		const sessionId = event.value.sessionId;
		if (latestUser?.sessionId === sessionId && latestUser.timestamp === user.timestamp) return;
		latestUser = { sessionId, timestamp: user.timestamp };
		process.parentPort.postMessage({ kind: "userAvailable", sessionId, userTimestamp: user.timestamp, at: Date.now() } satisfies BackendMessage);
	});
	let connection: ReturnType<typeof client.connect> | undefined;
	process.parentPort.on("message", ({ data }: { data: BackendCommand }) => {
		switch (data.kind) {
			case "subscribe":
				connection?.close();
				connection = client.connect((value) => process.parentPort.postMessage({ kind: "delivery", value, at: Date.now() } satisfies BackendMessage));
				void client.dispatch({ action: "observe", visible: true }).catch((error: unknown) => gui.reportError(error));
				return;
			case "ack": connection?.acknowledge(data.id); return;
			case "unsubscribe":
				connection?.close();
				connection = undefined;
				void client.dispatch({ action: "observe", visible: false }).catch((error: unknown) => gui.reportError(error));
				return;
			case "notice": gui.reportError(data.text); return;
			case "dispose":
				void dispose().then(
					() => process.exit(0),
					(error: unknown) => { console.error(error); process.exit(1); },
				);
				return;
			case "action": case "query": void execute(data); return;
			default: data satisfies never;
		}
	});
	async function execute(request: BackendRequest): Promise<void> {
		if (request.traced) process.parentPort.postMessage({ kind: "requestReceived", id: request.id, at: Date.now() } satisfies BackendMessage);
		try {
			const { value, sessionId } = decodeGuiRequest(request.value);
			const result = await (request.kind === "query" ? client.query(value, sessionId) : client.dispatch(value, sessionId));
			process.parentPort.postMessage({ kind: "result", id: request.id, value: result } satisfies BackendMessage);
		} catch (error) {
			process.parentPort.postMessage({
				kind: "error", id: request.id, message: error instanceof Error ? error.message : String(error),
			} satisfies BackendMessage);
		}
	}
	void gui
		.start(process.argv[2] ?? process.cwd())
		.catch((error: unknown) => gui.reportError(error));
} else {
	closeServices?.();
	// SDK 已释放会话并排空输出，Utility Process 不再保留宿主消息循环。
	if (process.type === "utility") process.exit(process.exitCode ?? 0);
}
