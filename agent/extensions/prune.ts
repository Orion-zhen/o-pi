import {
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { formatPruneOutcome } from "../../src/prune/presentation/outcome.js";
import { applyPersistedToolPruning } from "../../src/prune/prune.js";
import {
	PruneService,
	type PruneOperation,
	type PruneServicePort,
} from "../../src/prune/service.js";

const COMMAND_NAME = "prune";
const COMMAND_DESCRIPTION = "Remove stale tool transactions from context.";
const COMMAND_OPERATIONS = ["force", "restore"] as const;

type PruneApi = Pick<
	ExtensionAPI,
	"appendEntry" | "getActiveTools" | "getAllTools" | "on" | "registerCommand" | "registerEntryRenderer"
>;

export type PruneTuiModule = Pick<
	typeof import("../../src/prune/tui/index.js"),
	"registerPruneEntryRenderer" | "resetPruneTuiState" | "syncPruneTuiState"
>;

export type PruneTuiLoader = () => Promise<PruneTuiModule>;

export function createPruneExtension(
	loadTui: PruneTuiLoader = () => import("../../src/prune/tui/index.js"),
): (pi: PruneApi) => void {
	return function pruneExtension(pi: PruneApi): void {
		const service = new PruneService();
		let tuiModule: PruneTuiModule | undefined;
		let tuiLoad: Promise<PruneTuiModule | undefined> | undefined;
		const activateTui = async (
			ctx: Pick<ExtensionContext, "mode" | "sessionManager" | "ui">,
		): Promise<void> => {
			if (ctx.mode !== "tui") return;
			if (tuiLoad === undefined) {
				const pending = loadTui().then((module) => {
					module.registerPruneEntryRenderer(pi);
					tuiModule = module;
					return module;
				}, (error: unknown) => {
					tuiLoad = undefined;
					ctx.ui.notify(`Prune renderer initialization failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
					return undefined;
				});
				tuiLoad = pending;
			}
			const module = await tuiLoad;
			module?.syncPruneTuiState(ctx.sessionManager.getBranch());
		};

		pi.on("session_start", (_event, ctx) => activateTui(ctx));
		pi.on("session_tree", (_event, ctx) => activateTui(ctx));
		pi.on("session_shutdown", () => {
			tuiModule?.resetPruneTuiState();
		});

		pi.on("context", (event, ctx) => {
			const messages = applyPersistedToolPruning(event.messages, ctx.sessionManager.getBranch());
			if (messages === event.messages) return;
			return { messages };
		});

		pi.registerCommand(COMMAND_NAME, {
			description: COMMAND_DESCRIPTION,
			getArgumentCompletions: (argumentPrefix) => {
				const prefix = argumentPrefix.trim().toLowerCase();
				const completions = COMMAND_OPERATIONS
					.filter((operation) => operation.startsWith(prefix))
					.map((operation) => ({ label: operation, value: operation }));
				return completions.length > 0 ? completions : null;
			},
			async handler(args, ctx) {
				const operation = parseOperation(args);
				if (operation === undefined) {
					ctx.ui.notify("usage: /prune [force|restore]", "error");
					return;
				}
				const outcome = await service.execute({
					operation,
					model: ctx.model,
					port: createServicePort(pi, ctx),
				});
				const notice = formatPruneOutcome(outcome);
				ctx.ui.notify(notice.message, notice.type);
				if (ctx.mode === "tui") tuiModule?.syncPruneTuiState(ctx.sessionManager.getBranch());
			},
		});
	};
}

function parseOperation(args: string): PruneOperation | undefined {
	const operation = args.trim().toLowerCase();
	if (operation.length === 0) return "prune";
	if (operation === "force" || operation === "restore") return operation;
	return undefined;
}

function createServicePort(pi: PruneApi, ctx: ExtensionCommandContext): PruneServicePort {
	return {
		waitForIdle: () => ctx.waitForIdle(),
		getMessages: () => ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages),
		getBranch: () => ctx.sessionManager.getBranch(),
		appendState: (customType, state) => {
			pi.appendEntry(customType, state);
		},
		getActiveTools: () => pi.getActiveTools(),
		getAllTools: () => pi.getAllTools(),
		getSystemPrompt: () => ctx.getSystemPrompt(),
	};
}

export default createPruneExtension();
