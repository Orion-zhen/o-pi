import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { saveUserToolDefaults } from "./config.ts";
import { initialToolDefaults } from "./initial.ts";
import { syncToolSearch, toolSearchEnabled } from "../tool-search/loadout.ts";

export type ToolSelectionItem = Pick<ToolInfo, "name" | "description" | "exposure"> & (
	| { available: true; enabled: boolean }
	| { available: false; enabled: false }
);

export class ToolSelectionController {
	private baseline: string[] | undefined;
	private subagentAvailable = false;

	constructor(private readonly pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">) {}

	/** 开关控制声明集合，不表示权限。脚本专用和延迟工具仍可嵌套调用。 */
	listTools(tools = this.pi.getAllTools(), activeTools = this.pi.getActiveTools()): ToolSelectionItem[] {
		const active = new Set(activeTools);
		const searchAvailable = toolSearchEnabled(tools, activeTools);
		return tools.filter((tool) => tool.exposure !== "hidden").map(({ name, description, exposure }) => {
			const available = name === "tool_search" ? searchAvailable : this.selectable({ name, exposure });
			return { name, description, exposure, ...(available
				? { available: true as const, enabled: active.has(name) }
				: { available: false as const, enabled: false as const }) };
		});
	}

	/** 恢复交给 SDK，此处只应用新会话默认值和本地可用性约束。 */
	refresh(subagentAvailable: boolean, initialTools?: readonly string[]): void {
		this.subagentAvailable = subagentAvailable;
		this.apply(initialTools ?? this.pi.getActiveTools());
		this.baseline ??= this.selectedNames();
	}

	set(name: string, enabled: boolean): void {
		if (!this.selectableNames().has(name)) return;
		const names = new Set(this.pi.getActiveTools());
		if (enabled) names.add(name); else names.delete(name);
		this.apply([...names]);
	}

	hasUserDefaultChanges(defaultTools: string[] | undefined): boolean {
		const baseline = this.baseline;
		if (!baseline) return false;
		const defaults = initialToolDefaults({
			getActiveTools: () => baseline,
			getSettings: () => defaultTools === undefined ? {} : { defaultTools },
		}, [], {}) ?? baseline;
		const expected = new Set(defaults.filter((name) => name !== "tool_search"));
		const current = this.selectedNames();
		return current.length !== expected.size || current.some((name) => !expected.has(name));
	}

	persistUserDefaults(): Promise<string> {
		return saveUserToolDefaults(this.selectedNames());
	}

	private selectedNames(): string[] {
		const active = new Set(this.pi.getActiveTools());
		return [...this.selectableNames()].filter((name) => active.has(name));
	}

	private selectable(tool: Pick<ToolInfo, "name" | "exposure">): boolean {
		return tool.name !== "tool_search" && tool.exposure !== "hidden"
			&& (tool.name !== "powershell" || process.platform === "win32")
			&& (tool.name !== "subagent" || this.subagentAvailable);
	}

	private selectableNames(): Set<string> {
		return new Set(this.pi.getAllTools().filter((tool) => this.selectable(tool)).map((tool) => tool.name));
	}

	private apply(names: readonly string[]): void {
		const available = this.selectableNames();
		syncToolSearch(this.pi, names.filter((name) => available.has(name)));
	}
}
