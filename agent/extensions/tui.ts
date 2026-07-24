import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MathMarkdownLoader, TuiRuntime, TuiRuntimeModule } from "../../src/tui/runtime.js";

export type { MathMarkdownLoader, MathMarkdownModule, TuiRuntime, TuiRuntimeModule } from "../../src/tui/runtime.js";

/** o-pi TUI 的 native-only bootstrap；非 TUI 模式不会加载 TUI runtime。 */
const registeredApis = new WeakSet<object>();

export function createTuiExtension(
	loadMathMarkdown?: MathMarkdownLoader,
	loadTuiRuntime: TuiRuntimeLoader = loadDefaultTuiRuntime,
): (pi: ExtensionAPI) => void {
	return (pi) => {
		if (registeredApis.has(pi)) return;
		registeredApis.add(pi);
		let runtime: TuiRuntime | undefined;
		let runtimeModule: TuiRuntimeModule | undefined;
		let runtimeLoad: Promise<TuiRuntimeModule> | undefined;

		pi.on("session_start", async (_event, ctx) => {
			if (ctx.mode !== "tui") return;
			try {
				const module = await getTuiRuntime();
				runtime ??= module.createTuiRuntime(pi, loadMathMarkdown);
				await runtime.startSession(ctx);
			} catch (error) {
				await runtime?.dispose(ctx);
				ctx.ui.notify(`TUI runtime initialization failed: ${stringifyError(error)}`, "warning");
			}
		});

		function getTuiRuntime(): Promise<TuiRuntimeModule> {
			if (runtimeModule !== undefined) return Promise.resolve(runtimeModule);
			if (runtimeLoad !== undefined) return runtimeLoad;
			const pending = loadTuiRuntime().then((module) => {
				runtimeModule = module;
				runtimeLoad = undefined;
				return module;
			}, (error: unknown) => {
				runtimeLoad = undefined;
				throw error;
			});
			runtimeLoad = pending;
			return pending;
		}
	};
}

export type TuiRuntimeLoader = () => Promise<TuiRuntimeModule>;

async function loadDefaultTuiRuntime(): Promise<TuiRuntimeModule> {
	return import("../../src/tui/runtime.js");
}

function stringifyError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const tuiExtension = createTuiExtension();

export default tuiExtension;
