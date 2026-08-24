import {
	DynamicBorder,
	type ExtensionCommandContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	type Focusable,
} from "@earendil-works/pi-tui";

import type { ToolSelectionItem } from "../controller.js";

export interface ToolSelectorOptions {
	tools: readonly ToolSelectionItem[];
	onChange(toolName: string, enabled: boolean): void;
	onPersist(): Promise<boolean>;
}

interface ToolSelectorCallbacks {
	onChange(toolName: string, enabled: boolean): void;
	onPersist(): Promise<boolean>;
	onCancel(): void;
	requestRender(): void;
}

type ToolSelectorTheme = Pick<Theme, "bold" | "fg">;

class ToolRow {
	constructor(
		private readonly tool: ToolSelectionItem,
		private readonly selected: boolean,
		private readonly nameColumnWidth: number,
		private readonly theme: ToolSelectorTheme,
	) {}

	render(width: number): string[] {
		const icon = this.tool.enabled
			? this.theme.fg("success", "✓")
			: this.theme.fg("dim", "✗");
		const cursor = this.selected ? this.theme.fg("accent", "→ ") : "  ";
		const rawName = truncateToWidth(this.tool.name, this.nameColumnWidth, "");
		let name = rawName;
		if (!this.tool.enabled) name = this.theme.fg("dim", rawName);
		else if (this.selected) name = this.theme.fg("accent", rawName);
		const namePadding = " ".repeat(this.nameColumnWidth - visibleWidth(rawName));
		const leading = `${cursor}${icon} ${name}${namePadding}`;
		const descriptionWidth = width - visibleWidth(leading) - 2;
		if (descriptionWidth <= 0) return [truncateToWidth(leading, width, "")];
		const rawDescription = this.tool.available
			? this.tool.description
			: `${this.tool.description} (unavailable on this platform)`;
		const description = truncateToWidth(rawDescription.replace(/[\r\n]+/gu, " ").trim(), descriptionWidth, "");
		return [`${leading}  ${this.theme.fg("dim", description)}`];
	}

	invalidate(): void {}
}

/** 打开与 Pi scoped-models 选择器一致的工具多选界面。 */
export async function openToolSelector(
	ui: Pick<ExtensionCommandContext["ui"], "custom">,
	options: ToolSelectorOptions,
): Promise<void> {
	await ui.custom<void>((tui, theme, _keybindings, done) => new ToolSelectorComponent(
		options.tools,
		theme,
		{
			onChange: options.onChange,
			onPersist: options.onPersist,
			onCancel: () => done(undefined),
			requestRender: () => tui.requestRender(),
		},
	));
}

/** 工具选择组件。切换立即影响会话，只有显式保存才写入用户配置。 */
export class ToolSelectorComponent extends Container implements Focusable {
	private readonly tools: ToolSelectionItem[];
	private filteredTools: ToolSelectionItem[];
	private selectedIndex = 0;
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly footerText: Text;
	private revision = 0;
	private persistedRevision = 0;
	private saving = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		tools: readonly ToolSelectionItem[],
		private readonly theme: ToolSelectorTheme,
		private readonly callbacks: ToolSelectorCallbacks,
		private readonly maxVisible = 15,
	) {
		super();
		this.tools = tools.map((tool) => ({ ...tool }));
		this.filteredTools = this.tools;

		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Tool Configuration")), 0, 0));
		this.addChild(new Text(theme.fg("muted", "Session-only. Ctrl+S saves user defaults."), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.footerText = new Text(this.getFooterText(), 0, 0);
		this.addChild(this.footerText);
		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.updateList();
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) {
			if (this.filteredTools.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredTools.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			if (this.filteredTools.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredTools.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (
			keybindings.matches(data, "tui.select.confirm")
			|| (matchesKey(data, Key.space) && this.searchInput.getValue().length === 0)
		) {
			this.toggleSelected();
			return;
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			this.persist();
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.searchInput.getValue().length > 0) {
				this.searchInput.setValue("");
				this.refresh();
			} else {
				this.callbacks.onCancel();
			}
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.callbacks.onCancel();
			return;
		}

		this.searchInput.handleInput(data);
		this.refresh();
	}

	private toggleSelected(): void {
		const tool = this.filteredTools[this.selectedIndex];
		if (tool === undefined || !tool.available) return;
		tool.enabled = !tool.enabled;
		this.revision += 1;
		this.callbacks.onChange(tool.name, tool.enabled);
		this.updateList();
		this.footerText.setText(this.getFooterText());
	}

	private persist(): void {
		if (this.saving) return;
		const revision = this.revision;
		this.saving = true;
		this.footerText.setText(this.getFooterText());
		void this.callbacks.onPersist()
			.then((saved) => {
				if (saved) this.persistedRevision = revision;
			})
			.finally(() => {
				this.saving = false;
				this.footerText.setText(this.getFooterText());
				this.callbacks.requestRender();
			});
	}

	private refresh(): void {
		const query = this.searchInput.getValue();
		this.filteredTools = query.length === 0
			? this.tools
			: fuzzyFilter(this.tools, query, (tool) => `${tool.name} ${tool.description}`);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredTools.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.filteredTools.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching tools"), 0, 0));
			return;
		}

		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisible / 2),
				this.filteredTools.length - this.maxVisible,
			),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredTools.length);
		const nameColumnWidth = Math.min(30, Math.max(...this.filteredTools.map((tool) => visibleWidth(tool.name))));
		for (const [offset, tool] of this.filteredTools.slice(startIndex, endIndex).entries()) {
			this.listContainer.addChild(new ToolRow(
				tool,
				startIndex + offset === this.selectedIndex,
				nameColumnWidth,
				this.theme,
			));
		}
		if (startIndex > 0 || endIndex < this.filteredTools.length) {
			this.listContainer.addChild(new Text(
				this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredTools.length})`),
				0,
				0,
			));
		}
	}

	private getFooterText(): string {
		const enabledCount = this.tools.filter((tool) => tool.enabled).length;
		const state = this.saving
			? " · saving…"
			: this.revision !== this.persistedRevision
				? " · (unsaved)"
				: "";
		return this.theme.fg(
			"dim",
			`  Enter/Space toggle · Ctrl+S save · ${enabledCount}/${this.tools.length} enabled${state}`,
		);
	}
}
