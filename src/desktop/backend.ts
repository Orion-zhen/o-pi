import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
process.env.PI_OPI_RESOURCE_DIR = path.join(directory, "resources");
process.env.PI_PACKAGE_DIR = path.join(directory, "resources", "pi");
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";

if (process.argv[2] === "--opi-discord-daemon") {
	process.argv.splice(2, 1);
	await import("../harness/discord-presence/coordinator-daemon.ts");
} else if (process.env.PI_SUBAGENT_CHILD === "1") {
	await import("../cli.ts");
} else {
	const { GuiHost } = await import("../gui/host/host.ts");
	const gui = new GuiHost();
	let unsubscribe: (() => void) | undefined;
	process.parentPort.on("message", ({ data }: { data: unknown }) => {
		if (typeof data !== "object" || data === null || !("kind" in data)) return;
		if (data.kind === "subscribe") {
			unsubscribe?.();
			unsubscribe = gui.subscribe((value) => process.parentPort.postMessage({ kind: "event", value }));
		} else if (data.kind === "unsubscribe") {
			unsubscribe?.();
			unsubscribe = undefined;
		} else if (data.kind === "dispose") {
			void gui.dispose().then(
				() => process.exit(0),
				(error: unknown) => {
					console.error(error);
					process.exit(1);
				},
			);
		} else if (data.kind === "action" && "id" in data && typeof data.id === "string" && "value" in data) {
			const id = data.id;
			void gui.dispatch(data.value).then(
				() => process.parentPort.postMessage({ kind: "result", id }),
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
