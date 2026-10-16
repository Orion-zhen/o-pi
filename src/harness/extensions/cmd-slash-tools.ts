import {
	type ToolSelectionItem,
	ToolSelectionController,
} from "../tool-defaults/controller.ts";
import { canPresent, type Presenter } from "../presentation.ts";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../subagent/agents.ts";
import { loadSubagentConfig } from "../subagent/config.ts";
import { initialToolDefaults, type ToolStartupOptions } from "../tool-defaults/initial.ts";

interface ToolSelectorModule {
	openToolSelector(
		ui: ExtensionContext["ui"],
		options: {
			tools: readonly ToolSelectionItem[];
			onChange(toolName: string, enabled: boolean): ToolSelectionItem[];
			onPersist(): Promise<boolean>;
		},
	): Promise<void>;
}
type ToolSelectorLoader = () => Promise<ToolSelectorModule>;

/** 注册选择器与本地可用性约束，会话恢复由 SDK 负责。 */
export function createToolsExtension(
	loadTui?: ToolSelectorLoader,
	gui?: Presenter<(controller: ToolSelectionController) => void>,
	bindController?: (controller: ToolSelectionController) => void,
	startup: ToolStartupOptions = {},
): (pi: ExtensionAPI) => void {
	return function toolsExtension(pi: ExtensionAPI): void {
		const controller = new ToolSelectionController(pi);
		bindController?.(controller);

		const refresh = async (ctx: ExtensionContext, initialTools?: readonly string[]): Promise<void> => {
			const config = await loadSubagentConfig(ctx.cwd);
			controller.refresh(discoverAgents(ctx.cwd, config).agents.length > 0, initialTools);
		};

		pi.registerCommand("tools", {
			description: "Enable/disable tools",
			handler: async (_args, ctx) => {
				if (gui !== undefined && canPresent(ctx, gui)) {
					gui.show(controller);
					return;
				}
				if (ctx.mode !== "tui" || loadTui === undefined) {
					ctx.ui.notify("/tools requires TUI mode", "error");
					return;
				}

				const { openToolSelector } = await loadTui();
				await openToolSelector(ctx.ui, {
					tools: controller.listTools(),
					onChange(toolName, enabled) {
						controller.set(toolName, enabled);
						return controller.listTools();
					},
					async onPersist() {
						try {
							const filePath = await controller.persistUserDefaults();
							ctx.ui.notify(`Tool defaults saved to ${filePath}`);
							return true;
						} catch (error) {
							ctx.ui.notify(
								`Could not save tool defaults: ${error instanceof Error ? error.message : String(error)}`,
								"error",
							);
							return false;
						}
					},
				});
			},
		});

		pi.on("session_start", async (_event, ctx) => refresh(ctx, initialToolDefaults(pi, ctx.sessionManager.getBranch(), startup)));
		pi.on("session_tree", async (_event, ctx) => refresh(ctx));
	};
}

export default createToolsExtension();
