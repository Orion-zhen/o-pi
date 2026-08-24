import type { ToolInfo } from "@earendil-works/pi-coding-agent";

import {
	loadToolDefaultsConfig,
	resolveToolDefaults,
	saveUserToolDefaults,
	ToolDefaultsConfigError,
	type ToolDefaultsConfig,
	type ToolDefaultsModel,
} from "./config.js";

export const TOOL_SELECTION_ENTRY = "tools-config";

export interface ToolSelectionEntryData {
	enabledTools: string[];
}

export interface ToolSelectionBranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

interface ToolSelectionItemBase {
	name: string;
	description: string;
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
	private enabledTools = new Set<string>();
	private allTools: ToolInfo[] = [];
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
		this.refreshTools();
		return this.allTools.map((tool) => {
			const item = { name: tool.name, description: tool.description };
			return toolAvailableOnCurrentPlatform(tool)
				? { ...item, available: true, enabled: this.enabledTools.has(tool.name) }
				: { ...item, available: false, enabled: false };
		});
	}

	async restore(input: ToolSelectionRestoreInput): Promise<ToolSelectionRestoreNotice | undefined> {
		const revision = ++this.restoreRevision;
		if (input.refreshConfig) this.configCache = undefined;
		this.refreshTools();
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
			this.apply(this.namesFromSet(baseline));
			return { type: "config-error", message: defaults.message };
		}

		this.apply(defaults.enabledTools);
		return undefined;
	}

	set(toolName: string, enabled: boolean): void {
		if (!this.availableTools().some((tool) => tool.name === toolName)) return;
		if (enabled) this.enabledTools.add(toolName);
		else this.enabledTools.delete(toolName);
		const enabledTools = this.enabledToolNames();
		this.port.setActiveTools(enabledTools);
		this.port.appendEntry(TOOL_SELECTION_ENTRY, { enabledTools });
	}

	async persistUserDefaults(): Promise<string> {
		const defaults = Object.fromEntries(this.listTools().map((tool) => [tool.name, tool.enabled]));
		const filePath = await this.saveDefaults(defaults);
		this.configCache = undefined;
		return filePath;
	}

	private refreshTools(): void {
		this.allTools = this.port.getAllTools();
		const available = new Set(this.availableTools().map((tool) => tool.name));
		this.enabledTools = new Set([...this.enabledTools].filter((name) => available.has(name)));
	}

	private availableTools(): ToolInfo[] {
		return this.allTools.filter(toolAvailableOnCurrentPlatform);
	}

	private captureBaseline(): ReadonlySet<string> {
		if (this.baselineTools !== undefined) return this.baselineTools;
		const available = new Set(this.availableTools().map((tool) => tool.name));
		this.baselineTools = new Set(this.port.getActiveTools().filter((name) => available.has(name)));
		return this.baselineTools;
	}

	private namesFromSet(names: ReadonlySet<string>): string[] {
		return this.allTools.filter((tool) => names.has(tool.name)).map((tool) => tool.name);
	}

	private enabledToolNames(): string[] {
		return this.namesFromSet(this.enabledTools);
	}

	private apply(names: readonly string[]): void {
		const available = new Set(this.availableTools().map((tool) => tool.name));
		this.enabledTools = new Set(names.filter((name) => available.has(name)));
		this.port.setActiveTools(this.enabledToolNames());
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
				enabledTools: this.allTools
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
		if (entry.type !== "custom" || entry.customType !== TOOL_SELECTION_ENTRY) continue;
		const data = entry.data;
		if (!isRecord(data) || !Array.isArray(data["enabledTools"])) continue;
		const names = data["enabledTools"];
		if (names.every((name) => typeof name === "string")) savedTools = [...new Set(names)];
	}
	return savedTools;
}

function toolAvailableOnCurrentPlatform(tool: ToolInfo): boolean {
	return tool.name !== "powershell" || process.platform === "win32";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
