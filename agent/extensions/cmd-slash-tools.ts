/**
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools interactively.
 * Tool selection persists across session reloads and respects branch navigation.
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /tools to open the tool selector
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { isToolEnabledByDefault, loadToolDefaultsConfig } from "../../src/tool-defaults/config.js";

// State persisted to session
interface ToolsState {
	enabledTools: string[];
}

export default function toolsExtension(pi: ExtensionAPI) {
	// Track enabled tools
	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];

	// Persist current state
	function persistState() {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
	}

	// Apply current tool selection
	function applyTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	async function loadDefaultEnabledToolNames(ctx: ExtensionContext, tools: ToolInfo[]): Promise<string[]> {
		try {
			const config = await loadToolDefaultsConfig(ctx.cwd);
			return tools.filter((tool) => isToolEnabledByDefault(config, tool.name)).map((tool) => tool.name);
		} catch (error) {
			ctx.ui.notify(`tools config ignored: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return tools.map((tool) => tool.name);
		}
	}

	// Find the last tools-config entry in the current branch
	async function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();

		// Get entries in current branch only
		const branchEntries = ctx.sessionManager.getBranch();
		let savedTools: string[] | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = entry.data as ToolsState | undefined;
				if (data?.enabledTools) {
					savedTools = data.enabledTools;
				}
			}
		}

		if (savedTools) {
			// Restore saved tool selection (filter to only tools that still exist)
			const allToolNames = allTools.map((t) => t.name);
			enabledTools = new Set(savedTools.filter((t: string) => allToolNames.includes(t)));
			applyTools();
		} else {
			// No session override - use config defaults. Missing config keys mean enabled.
			enabledTools = new Set(await loadDefaultEnabledToolNames(ctx, allTools));
			applyTools();
		}
	}

	// Register /tools command
	pi.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires TUI mode", "error");
				return;
			}

			// Refresh tool list
			allTools = pi.getAllTools();

			await ctx.ui.custom((tui, theme, _kb, done) => {
				// Build settings items for each tool
				const items: SettingItem[] = allTools.map((tool) => ({
					id: tool.name,
					label: tool.name,
					currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
					values: ["enabled", "disabled"],
				}));

				const container = new Container();
				container.addChild(
					new (class {
						render(_width: number) {
							return [theme.fg("accent", theme.bold("Tool Configuration")), ""];
						}
						invalidate() {}
					})(),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						// Update enabled state and apply immediately
						if (newValue === "enabled") {
							enabledTools.add(id);
						} else {
							enabledTools.delete(id);
						}
						applyTools();
						persistState();
					},
					() => {
						// Close dialog
						done(undefined);
					},
				);

				container.addChild(settingsList);

				const component = {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};

				return component;
			});
		},
	});

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		await restoreFromBranch(ctx);
	});

	// Restore state when navigating the session tree
	pi.on("session_tree", async (_event, ctx) => {
		await restoreFromBranch(ctx);
	});
}
