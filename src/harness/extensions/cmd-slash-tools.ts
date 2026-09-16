import {
	type ToolSelectionItem,
	ToolSelectionController,
	type ToolSelectionRestoreNotice,
} from "../tool-defaults/controller.ts";
import { canPresent, type Presenter } from "../presentation.ts";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

interface ToolSelectorModule {
	openToolSelector(
		ui: ExtensionContext["ui"],
		options: {
			tools: readonly ToolSelectionItem[];
			onChange(toolName: string, enabled: boolean): void;
			onPersist(): Promise<boolean>;
		},
	): Promise<void>;
}
type ToolSelectorLoader = () => Promise<ToolSelectorModule>;

/** 注册工具选择生命周期；配置、恢复与持久化由 controller 负责。 */
export function createToolsExtension(
	loadTui?: ToolSelectorLoader,
	gui?: Presenter<(controller: ToolSelectionController) => void>,
	bindController?: (controller: ToolSelectionController) => void,
): (pi: ExtensionAPI) => void {
	return function toolsExtension(pi: ExtensionAPI): void {
		const controller = new ToolSelectionController(pi);
		bindController?.(controller);

		const restore = async (ctx: ExtensionContext, model = ctx.model, refreshConfig = false): Promise<void> => {
			const notice = await controller.restore({
				cwd: ctx.cwd,
				branchEntries: ctx.sessionManager.getBranch(),
				model,
				refreshConfig,
			});
			notifyRestoreIssue(ctx, notice);
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

		pi.on("session_start", async (_event, ctx) => restore(ctx, ctx.model, true));
		pi.on("session_tree", async (_event, ctx) => restore(ctx, ctx.model, true));
		pi.on("model_select", async (event, ctx) => restore(ctx, event.model));
	};
}

function notifyRestoreIssue(ctx: ExtensionContext, notice: ToolSelectionRestoreNotice | undefined): void {
	if (notice?.type === "config-error") {
		ctx.ui.notify(`tools config ignored: ${notice.message}`, "warning");
		return;
	}
	if (notice?.type === "removed-tools") {
		ctx.ui.notify(`Removed unavailable tools from branch selection: ${notice.toolNames.join(", ")}`, "warning");
	}
}

export default createToolsExtension();
