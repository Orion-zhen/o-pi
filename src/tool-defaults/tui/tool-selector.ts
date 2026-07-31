import { getSettingsListTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList } from "@earendil-works/pi-tui";

import type { ToolSelectionItem } from "../controller.js";

export interface ToolSelectorOptions {
	tools: readonly ToolSelectionItem[];
	onChange(toolName: string, enabled: boolean): void;
}

/** 打开 Pi TUI 工具选择器；状态变更通过窄回调交回 application adapter。 */
export async function openToolSelector(
	ui: Pick<ExtensionCommandContext["ui"], "custom">,
	options: ToolSelectorOptions,
): Promise<void> {
	await ui.custom<void>((tui, theme, _keybindings, done) => {
		const items = options.tools.map((tool) => ({
			id: tool.name,
			label: tool.name,
			currentValue: tool.enabled ? "enabled" : "disabled",
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
				options.onChange(id, newValue === "enabled");
			},
			() => {
				done(undefined);
			},
		);
		container.addChild(settingsList);

		return {
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
	});
}
