import type { ToolInfo } from "@earendil-works/pi-coding-agent";

import {
	loadToolDefaultsConfig,
	resolveToolDefaults,
	saveUserToolDefaults,
	ToolDefaultsConfigError,
	type ToolDefaultsConfig,
	type ToolDefaultsModel,
} from "./config.ts";

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

export type ToolSelectionRestoreNotice =
	| { type: "config-error"; message: string }
	| { type: "removed-tools"; toolNames: string[] };

export interface ToolSelectionPort {
	getAllTools(): ToolInfo[];
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
	appendEntry(customType: string, data: ToolSelectionEntryData): void;
}

export interface ToolSelectionRestoreInput {
	cwd: string;
	branchEntries: readonly ToolSelectionBranchEntry[];
	model: ToolDefaultsModel | undefined;
	refreshConfig: boolean;
}

export interface ToolSelectionControllerOptions {
	loadConfig?(cwd: string): Promise<ToolDefaultsConfig>;
	saveUserDefaults?(defaults: Readonly<Record<string, boolean>>): Promise<string>;
}

export class ToolSelectionController {
	private baselineTools: ReadonlySet<string> | undefined;
	private configCache: { cwd: string; value: Promise<ToolDefaultsConfig> } | undefined;
	private restoreRevision = 0;
	private readonly loadConfig: (cwd: string) => Promise<ToolDefaultsConfig>;
	private readonly saveDefaults: (defaults: Readonly<Record<string, boolean>>) => Promise<string>;

	constructor(
		private readonly port: ToolSelectionPort,
		options: ToolSelectionControllerOptions = {},
	) {
		this.loadConfig = options.loadConfig ?? loadToolDefaultsConfig;
		this.saveDefaults = options.saveUserDefaults ?? saveUserToolDefaults;
	}

	listTools(): ToolSelectionItem[] {
		return toolSelectionItems(this.port.getAllTools(), this.port.getActiveTools());
	}

	async restore(input: ToolSelectionRestoreInput): Promise<ToolSelectionRestoreNotice | undefined> {
		const revision = ++this.restoreRevision;
		if (input.refreshConfig) this.configCache = undefined;
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

		const defaults = await this.resolveDefaults(input.cwd, input.model, baseline);
		if (revision !== this.restoreRevision) return undefined;
		if (defaults.status === "config-error") {
			this.apply([...baseline]);
			return { type: "config-error", message: defaults.message };
		}

		this.apply(defaults.enabledTools);
		return undefined;
	}

	set(toolName: string, enabled: boolean): void {
		if (!this.availableTools().some((tool) => tool.name === toolName)) return;
		this.restoreRevision++;
		const names = new Set(this.port.getActiveTools());
		if (enabled) names.add(toolName);
		else names.delete(toolName);
		const enabledTools = this.apply([...names]);
		this.port.appendEntry(TOOL_SELECTION_ENTRY, { enabledTools });
	}

	async persistUserDefaults(): Promise<string> {
		const defaults = Object.fromEntries(this.listTools().map((tool) => [tool.name, tool.enabled]));
		const filePath = await this.saveDefaults(defaults);
		this.configCache = undefined;
		return filePath;
	}

	private availableTools(): ToolInfo[] {
		return this.port.getAllTools().filter(toolAvailableOnCurrentPlatform);
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

	private async resolveDefaults(
		cwd: string,
		model: ToolDefaultsModel | undefined,
		baseline: ReadonlySet<string>,
	): Promise<{ status: "ready"; enabledTools: string[] } | { status: "config-error"; message: string }> {
		try {
			if (this.configCache?.cwd !== cwd) {
				this.configCache = { cwd, value: this.loadConfig(cwd) };
			}
			const config = await this.configCache.value;
			const defaults = resolveToolDefaults(config, model);
			return {
				status: "ready",
				enabledTools: this.availableTools()
					.filter((tool) => defaults[tool.name] ?? baseline.has(tool.name))
					.map((tool) => tool.name),
			};
		} catch (error) {
			if (!(error instanceof ToolDefaultsConfigError)) throw error;
			return { status: "config-error", message: error.message };
		}
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

export function toolAvailableOnCurrentPlatform(tool: ToolInfo): boolean {
	return tool.exposure !== "hidden" && (tool.name !== "powershell" || process.platform === "win32");
}

/** 开关控制声明集合，不表示权限。脚本专用和延迟工具在未勾选时仍可嵌套调用。 */
export function toolSelectionItems(tools: readonly ToolInfo[], active: readonly string[]): ToolSelectionItem[] {
	const enabled = new Set(active);
	return tools.filter((tool) => tool.exposure !== "hidden").map((tool) => {
		const item = { name: tool.name, description: tool.description, exposure: tool.exposure };
		return toolAvailableOnCurrentPlatform(tool)
			? { ...item, available: true, enabled: enabled.has(tool.name) }
			: { ...item, available: false, enabled: false };
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
