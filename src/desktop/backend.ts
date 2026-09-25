import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeGuiRequest } from "../gui/host/request.ts";

const directory = path.dirname(fileURLToPath(import.meta.url));
process.env.PI_OPI_RESOURCE_DIR = path.join(directory, "resources");
process.env.PI_PACKAGE_DIR = path.join(directory, "resources", "pi");
await import("../harness/runtime/environment.ts");

const closeServices = process.type === "utility"
	? await (await import("./worker-runtime.ts")).initializeDesktopWorker() : undefined;

const { runChildProcess } = await import("../harness/runtime/invocation.ts");
if (!(await runChildProcess())) {
	const { GuiHost } = await import("../gui/host/host.ts");
	const gui = new GuiHost();
	const client = gui.createClient();
	let connection: ReturnType<typeof client.connect> | undefined;
	process.parentPort.on("message", ({ data }: { data: unknown }) => {
		if (typeof data !== "object" || data === null || !("kind" in data)) return;
		if (data.kind === "subscribe") {
			connection?.close();
			connection = client.connect((value) => process.parentPort.postMessage({ kind: "event", value }));
			void client.dispatch({ action: "observe", visible: true }).catch((error: unknown) => gui.reportError(error));
		} else if (data.kind === "ack" && "id" in data && typeof data.id === "number") {
			connection?.acknowledge(data.id);
		} else if (data.kind === "unsubscribe") {
			connection?.close();
			connection = undefined;
			void client.dispatch({ action: "observe", visible: false }).catch((error: unknown) => gui.reportError(error));
		} else if (data.kind === "notice" && "text" in data && typeof data.text === "string") {
			gui.reportError(data.text);
		} else if (data.kind === "dispose") {
			void gui.dispose().then(
				() => process.exit(0),
				(error: unknown) => {
					console.error(error);
					process.exit(1);
				},
			);
		} else if ((data.kind === "action" || data.kind === "query") && "id" in data && typeof data.id === "string" && "value" in data) {
			const id = data.id;
			const task = Promise.resolve().then(async (): Promise<unknown> => {
				const { value, sessionId } = decodeGuiRequest(data.value);
				return data.kind === "query" ? client.query(value, sessionId) : client.dispatch(value, sessionId);
			});
			void task.then(
				(value) => process.parentPort.postMessage({ kind: "result", id, value }),
				(error: unknown) =>
					process.parentPort.postMessage({
						kind: "result",
						id,
						error: error instanceof Error ? error.message : String(error),
					}),
			);
		}
	});
	void gui
		.start(process.argv[2] ?? process.cwd())
		.catch((error: unknown) => gui.reportError(error));
} else {
	closeServices?.();
	// SDK 已释放会话并排空输出，Utility Process 不再保留宿主消息循环。
	if (process.type === "utility") process.exit(process.exitCode ?? 0);
}
