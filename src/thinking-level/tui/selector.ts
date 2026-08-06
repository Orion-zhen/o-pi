import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, Text, type SelectListTheme } from "@earendil-works/pi-tui";

import type { ThinkingLevelOption } from "../controller.js";

const SELECT_LIST_LAYOUT = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/** 打开 thinking level 选择器，并把当前等级作为初始选中项。 */
export async function selectThinkingLevel(
	ui: Pick<ExtensionCommandContext["ui"], "custom">,
	title: string,
	options: readonly ThinkingLevelOption[],
	currentLevel: ModelThinkingLevel,
): Promise<ModelThinkingLevel | undefined> {
	return ui.custom<ModelThinkingLevel | undefined>((tui, theme, _keybindings, done) => {
		const items = options.map(({ level, label }) => ({ value: level, label }));
		const selectListTheme: SelectListTheme = {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("dim", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		};
		const selectList = new SelectList(items, items.length, selectListTheme, SELECT_LIST_LAYOUT);
		const currentIndex = options.findIndex(({ level }) => level === currentLevel);
		if (currentIndex >= 0) selectList.setSelectedIndex(currentIndex);

		selectList.onSelect = (item) => {
			const selected = options.find(({ level }) => level === item.value);
			if (selected !== undefined) done(selected.level);
		};
		selectList.onCancel = () => done(undefined);

		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(selectList);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate  enter select  esc cancel"), 1, 0));

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
