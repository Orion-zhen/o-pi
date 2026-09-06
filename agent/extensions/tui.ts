import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TuiRuntime } from "../../src/tui/runtime.js";

/** Pi 为每次扩展初始化提供独立 API，非 TUI 模式不加载运行时。 */
export default function tuiExtension(pi: ExtensionAPI): void {
	let runtime: TuiRuntime | undefined;
	pi.on("session_start", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		try {
			const module = await import("../../src/tui/runtime.js");
			runtime ??= module.createTuiRuntime(pi);
			await runtime.startSession(ctx, event.reason === "startup");
		} catch (error) {
			await runtime?.dispose();
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`TUI runtime initialization failed: ${message}`, "warning");
		}
	});
}
