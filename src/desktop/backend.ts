import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

const directory = path.dirname(fileURLToPath(import.meta.url));
process.env.PI_OPI_RESOURCE_DIR = path.join(directory, "resources");
process.env.PI_PACKAGE_DIR = path.join(directory, "resources", "pi");
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
registerBunOAuthFlows();

const { runChildProcess } = await import("../harness/runtime/invocation.ts");
if (!(await runChildProcess())) {
	const { GuiHost } = await import("../gui/host/host.ts");
	const gui = new GuiHost();
	let connection: ReturnType<InstanceType<typeof GuiHost>["connect"]> | undefined;
	process.parentPort.on("message", ({ data }: { data: unknown }) => {
		if (typeof data !== "object" || data === null || !("kind" in data)) return;
		if (data.kind === "subscribe") {
			connection?.close();
			connection = gui.connect((value) => process.parentPort.postMessage({ kind: "event", value }));
		} else if (data.kind === "ack" && "id" in data && typeof data.id === "number") {
			connection?.acknowledge(data.id);
		} else if (data.kind === "unsubscribe") {
			connection?.close();
			connection = undefined;
		} else if (data.kind === "notice" && "text" in data && typeof data.text === "string") {
			gui.dialogs.notify(data.text);
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
			const task = data.kind === "query" ? gui.query(data.value) : gui.dispatch(data.value);
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
		.catch((error: unknown) => gui.dialogs.notify(error instanceof Error ? error.message : String(error), "error"));
}
