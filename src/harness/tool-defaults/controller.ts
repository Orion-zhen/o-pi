import type { ToolInfo } from "@earendil-works/pi-coding-agent";

import { saveUserToolDefaults } from "./config.ts";

export const TOOL_SELECTION_ENTRY = "tools-config";

export interface ToolSelectionEntryData {
	enabledTools: string[];
}

export interface ToolSelectionBranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
	message?: unknown;
}

interface ToolSelectionItemBase {
	name: string;
	description: string;
	exposure: ToolInfo["exposure"];
}

export type ToolSelectionItem = ToolSelectionItemBase & (
	| { available: true; enabled: boolean }
	| { available: false; enabled: false }
);

export type ToolSelectionRestoreNotice = { type: "removed-tools"; toolNames: string[] };

export interface ToolSelectionPort {
	getAllTools(): ToolInfo[];
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
	appendEntry(customType: string, data: ToolSelectionEntryData): void;
}

export interface ToolSelectionRestoreInput {
	branchEntries: readonly ToolSelectionBranchEntry[];
}

export interface ToolSelectionControllerOptions {
	saveUserDefaults?(tools: readonly string[]): Promise<string>;
}

export class ToolSelectionController {
	private baselineTools: ReadonlySet<string> | undefined;
	private subagentAvailable = false;
	private readonly saveDefaults: (tools: readonly string[]) => Promise<string>;

	constructor(
		private readonly port: ToolSelectionPort,
		options: ToolSelectionControllerOptions = {},
	) {
		this.saveDefaults = options.saveUserDefaults ?? saveUserToolDefaults;
	}

	listTools(): ToolSelectionItem[] {
		return toolSelectionItems(this.port.getAllTools(), this.port.getActiveTools(), this.subagentAvailable);
	}

	setSubagentAvailable(available: boolean): void {
		this.subagentAvailable = available;
	}

	restore(input: ToolSelectionRestoreInput): ToolSelectionRestoreNotice | undefined {
		const baseline = this.captureBaseline();
		const savedTools = findSavedTools(input.branchEntries);
		if (savedTools !== undefined) {
			const available = new Set(this.availableTools().map((tool) => tool.name));
			const removedTools = savedTools.filter((name) => !available.has(name));
			this.apply(savedTools);
			return removedTools.length === 0
				? undefined
				: { type: "removed-tools", toolNames: removedTools };
		}

		this.apply([...baseline]);
		return undefined;
	}

	set(toolName: string, enabled: boolean): void {
		if (!this.availableTools().some((tool) => tool.name === toolName)) return;
		const names = new Set(this.port.getActiveTools());
		if (enabled) names.add(toolName);
		else names.delete(toolName);
		const enabledTools = this.apply([...names]);
		this.port.appendEntry(TOOL_SELECTION_ENTRY, { enabledTools });
	}

	async persistUserDefaults(): Promise<string> {
		return this.saveDefaults(this.listTools().filter((tool) => tool.enabled).map((tool) => tool.name));
	}

	private availableTools(): ToolInfo[] {
		return this.port.getAllTools().filter((tool) => toolAvailableOnCurrentPlatform(tool, this.subagentAvailable));
	}

	private captureBaseline(): ReadonlySet<string> {
		if (this.baselineTools !== undefined) return this.baselineTools;
		const available = new Set(this.availableTools().map((tool) => tool.name));
		this.baselineTools = new Set(this.port.getActiveTools().filter((name) => available.has(name)));
		return this.baselineTools;
	}

	private apply(names: readonly string[]): string[] {
		const available = new Set(this.availableTools().map((tool) => tool.name));
		const enabledTools = [...new Set(names)].filter((name) => available.has(name));
		const current = this.port.getActiveTools();
		// SDK 已恢复相同选择时保留其声明顺序，避免重建提示词和工具前缀。
		if (current.length === enabledTools.length && current.every((name) => enabledTools.includes(name))) return current;
		this.port.setActiveTools(enabledTools);
		return enabledTools;
	}

}

function findSavedTools(branchEntries: readonly ToolSelectionBranchEntry[]): string[] | undefined {
	let savedTools: string[] | undefined;
	for (const entry of branchEntries) {
		// 用户选择后的 SDK 工具变更（如 tool_search）优先，避免恢复旧手动快照覆盖已发现工具。
		if (savedTools !== undefined && entry.type === "message" && isRecord(entry.message) && entry.message["role"] === "system") {
			const added = entry.message["toolsAdded"], removed = entry.message["toolsRemoved"];
			const names = new Set(savedTools);
			if (Array.isArray(removed)) for (const tool of removed) if (isRecord(tool) && typeof tool["name"] === "string") names.delete(tool["name"]);
			if (Array.isArray(added)) for (const tool of added) if (isRecord(tool) && typeof tool["name"] === "string") names.add(tool["name"]);
			savedTools = [...names];
		}
		if (entry.type !== "custom" || entry.customType !== TOOL_SELECTION_ENTRY) continue;
		const data = entry.data;
		if (!isRecord(data) || !Array.isArray(data["enabledTools"])) continue;
		const names = data["enabledTools"];
		if (names.every((name) => typeof name === "string")) savedTools = [...new Set(names)];
	}
	return savedTools;
}

export function toolAvailableOnCurrentPlatform(tool: ToolInfo, subagentAvailable = false): boolean {
	return tool.exposure !== "hidden"
		&& (tool.name !== "powershell" || process.platform === "win32")
		&& (tool.name !== "subagent" || subagentAvailable);
}

/** 开关控制声明集合，不表示权限。脚本专用和延迟工具在未勾选时仍可嵌套调用。 */
export function toolSelectionItems(tools: readonly ToolInfo[], active: readonly string[], subagentAvailable = false): ToolSelectionItem[] {
	const enabled = new Set(active);
	return tools.filter((tool) => tool.exposure !== "hidden").map((tool) => {
		const item = { name: tool.name, description: tool.description, exposure: tool.exposure };
		return toolAvailableOnCurrentPlatform(tool, subagentAvailable)
			? { ...item, available: true, enabled: enabled.has(tool.name) }
			: { ...item, available: false, enabled: false };
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
