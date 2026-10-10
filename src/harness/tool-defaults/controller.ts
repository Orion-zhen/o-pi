import type { ExtensionAPI, SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import { saveUserToolDefaults } from "./config.ts";
import { initialToolDefaults } from "./initial.ts";
import { syncToolSearch, toolSearchEnabled } from "../tool-search/loadout.ts";

const TOOL_SELECTION_ENTRY = "tools-config";

export type ToolSelectionItem = Pick<ToolInfo, "name" | "description" | "exposure"> & (
	| { available: true; enabled: boolean }
	| { available: false; enabled: false }
);

export class ToolSelectionController {
	private baseline: string[] | undefined;
	private subagentAvailable = false;

	constructor(private readonly pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools" | "appendEntry">) {}

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

	restore(branch: readonly SessionEntry[], subagentAvailable: boolean, initialTools?: readonly string[]): string[] {
		this.subagentAvailable = subagentAvailable;
		const available = this.selectableNames();
		this.baseline ??= [...initialTools ?? this.pi.getActiveTools()].filter((name) => available.has(name));
		const saved = findSavedTools(branch);
		const names = saved ?? this.baseline;
		this.apply(names);
		return saved ? saved.filter((name) => !available.has(name)) : [];
	}

	set(name: string, enabled: boolean): void {
		if (!this.selectableNames().has(name)) return;
		const names = new Set(this.pi.getActiveTools());
		if (enabled) names.add(name); else names.delete(name);
		this.pi.appendEntry(TOOL_SELECTION_ENTRY, { enabledTools: this.apply([...names]) });
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

	private apply(names: readonly string[]): string[] {
		const available = this.selectableNames();
		const enabled = names.filter((name) => available.has(name));
		syncToolSearch(this.pi, enabled);
		return enabled;
	}
}

function findSavedTools(branch: readonly SessionEntry[]): string[] | undefined {
	let saved: Set<string> | undefined;
	for (const entry of branch) {
		// 手动快照之后的 SDK 工具变更优先，避免丢失 tool_search 新发现的工具。
		if (saved && entry.type === "message" && entry.message.role === "system") {
			for (const tool of entry.message.toolsRemoved ?? []) saved.delete(tool.name);
			for (const tool of entry.message.toolsAdded ?? []) saved.add(tool.name);
		}
		if (entry.type !== "custom" || entry.customType !== TOOL_SELECTION_ENTRY) continue;
		const data: unknown = entry.data;
		if (typeof data !== "object" || data === null || !("enabledTools" in data)) continue;
		const names: unknown = data.enabledTools;
		if (Array.isArray(names) && names.every((name): name is string => typeof name === "string")) saved = new Set(names);
	}
	return saved ? [...saved].filter((name) => name !== "tool_search") : undefined;
}
