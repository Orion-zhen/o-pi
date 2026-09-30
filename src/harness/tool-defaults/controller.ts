import type { ExtensionAPI, SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import { saveUserToolDefaults } from "./config.ts";

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
		return tools.filter((tool) => tool.exposure !== "hidden").map(({ name, description, exposure }) => ({
			name, description, exposure,
			...(this.available({ name, exposure })
				? { available: true as const, enabled: active.has(name) }
				: { available: false as const, enabled: false as const }),
		}));
	}

	restore(branch: readonly SessionEntry[], subagentAvailable: boolean): string[] {
		this.subagentAvailable = subagentAvailable;
		const available = this.availableNames();
		this.baseline ??= this.pi.getActiveTools().filter((name) => available.has(name));
		const saved = findSavedTools(branch);
		const names = saved ?? this.baseline;
		this.apply(names);
		return saved ? saved.filter((name) => !available.has(name)) : [];
	}

	set(name: string, enabled: boolean): void {
		if (!this.availableNames().has(name)) return;
		const names = new Set(this.pi.getActiveTools());
		if (enabled) names.add(name); else names.delete(name);
		this.pi.appendEntry(TOOL_SELECTION_ENTRY, { enabledTools: this.apply([...names]) });
	}

	persistUserDefaults(): Promise<string> {
		return saveUserToolDefaults(this.listTools().filter((tool) => tool.enabled).map((tool) => tool.name));
	}

	private available(tool: Pick<ToolInfo, "name" | "exposure">): boolean {
		return tool.exposure !== "hidden"
			&& (tool.name !== "powershell" || process.platform === "win32")
			&& (tool.name !== "subagent" || this.subagentAvailable);
	}

	private availableNames(): Set<string> {
		return new Set(this.pi.getAllTools().filter((tool) => this.available(tool)).map((tool) => tool.name));
	}

	private apply(names: readonly string[]): string[] {
		const available = this.availableNames();
		const enabled = [...new Set(names)].filter((name) => available.has(name));
		const current = this.pi.getActiveTools();
		// SDK 已恢复相同选择时保留声明顺序，避免重建提示词和工具前缀。
		if (current.length === enabled.length && current.every((name) => enabled.includes(name))) return current;
		this.pi.setActiveTools(enabled);
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
	return saved ? [...saved] : undefined;
}
