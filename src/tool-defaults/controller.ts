import type { ToolInfo } from "@earendil-works/pi-coding-agent";

import {
	loadToolDefaultsConfig,
	resolveToolDefaults,
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

export interface ToolSelectionItem {
	name: string;
	description: string;
	enabled: boolean;
}

export interface ToolSelectionSnapshot {
	tools: ToolSelectionItem[];
	enabledTools: string[];
	empty: boolean;
}

export type ToolSelectionIssue = "EMPTY_SELECTION" | "REMOVED_TOOLS";

export type ToolSelectionRestoreOutcome =
	| {
		status: "restored";
		source: "branch" | "defaults";
		issues: ToolSelectionIssue[];
		removedTools: string[];
		snapshot: ToolSelectionSnapshot;
	}
	| {
		status: "degraded";
		source: "defaults";
		code: "CONFIG_ERROR";
		message: string;
		issues: ToolSelectionIssue[];
		removedTools: [];
		snapshot: ToolSelectionSnapshot;
	}
	| {
		status: "superseded";
		snapshot: ToolSelectionSnapshot;
	};

export type ToolSelectionOperationOutcome =
	| {
		status: "applied";
		operation: "set" | "toggle" | "reset";
		code: "UPDATED" | "UNCHANGED" | "EMPTY_SELECTION";
		persisted: boolean;
		snapshot: ToolSelectionSnapshot;
	}
	| {
		status: "rejected";
		operation: "set" | "toggle";
		code: "UNKNOWN_TOOL";
		toolName: string;
		snapshot: ToolSelectionSnapshot;
	}
	| {
		status: "degraded";
		operation: "reset";
		code: "CONFIG_ERROR";
		message: string;
		persisted: boolean;
		snapshot: ToolSelectionSnapshot;
	}
	| {
		status: "superseded";
		operation: "reset";
		snapshot: ToolSelectionSnapshot;
	};

export interface ToolSelectionPort {
	getAllTools(): ToolInfo[];
	setActiveTools(names: string[]): void;
	appendEntry(customType: string, data: ToolSelectionEntryData): void;
}

export interface ToolSelectionRestoreInput {
	cwd: string;
	branchEntries: readonly ToolSelectionBranchEntry[];
	model: ToolDefaultsModel | undefined;
	refreshConfig?: boolean;
}

export interface ToolSelectionResetInput {
	cwd: string;
	model: ToolDefaultsModel | undefined;
	refreshConfig?: boolean;
	persist?: boolean;
}

export interface ToolSelectionControllerOptions {
	loadConfig?(cwd: string): Promise<ToolDefaultsConfig>;
}

export class ToolSelectionController {
	private enabledTools = new Set<string>();
	private allTools: ToolInfo[] = [];
	private configCache: { cwd: string; value: Promise<ToolDefaultsConfig> } | undefined;
	private restoreRevision = 0;
	private readonly loadConfig: (cwd: string) => Promise<ToolDefaultsConfig>;

	constructor(
		private readonly port: ToolSelectionPort,
		options: ToolSelectionControllerOptions = {},
	) {
		this.loadConfig = options.loadConfig ?? loadToolDefaultsConfig;
	}

	snapshot(): ToolSelectionSnapshot {
		const tools = this.allTools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			enabled: this.enabledTools.has(tool.name),
		}));
		const enabledTools = tools.filter((tool) => tool.enabled).map((tool) => tool.name);
		return { tools, enabledTools, empty: enabledTools.length === 0 };
	}

	refreshSnapshot(): ToolSelectionSnapshot {
		this.refreshTools();
		return this.snapshot();
	}

	async restore(input: ToolSelectionRestoreInput): Promise<ToolSelectionRestoreOutcome> {
		const revision = ++this.restoreRevision;
		if (input.refreshConfig) this.configCache = undefined;
		this.refreshTools();
		const savedTools = findSavedTools(input.branchEntries);
		if (savedTools !== undefined) {
			const available = new Set(this.allTools.map((tool) => tool.name));
			const removedTools = savedTools.filter((name) => !available.has(name));
			this.apply(savedTools.filter((name) => available.has(name)));
			const snapshot = this.snapshot();
			return {
				status: "restored",
				source: "branch",
				issues: collectIssues(snapshot, removedTools),
				removedTools,
				snapshot,
			};
		}

		const defaults = await this.resolveDefaults(input.cwd, input.model, input.refreshConfig ?? false);
		if (revision !== this.restoreRevision) return { status: "superseded", snapshot: this.snapshot() };
		if (defaults.status === "error") {
			this.apply(this.allTools.map((tool) => tool.name));
			const snapshot = this.snapshot();
			return {
				status: "degraded",
				source: "defaults",
				code: "CONFIG_ERROR",
				message: defaults.message,
				issues: collectIssues(snapshot, []),
				removedTools: [],
				snapshot,
			};
		}

		this.apply(defaults.enabledTools);
		const snapshot = this.snapshot();
		return {
			status: "restored",
			source: "defaults",
			issues: collectIssues(snapshot, []),
			removedTools: [],
			snapshot,
		};
	}

	set(toolName: string, enabled: boolean, persist = true): ToolSelectionOperationOutcome {
		this.refreshTools();
		const tool = this.allTools.find((candidate) => candidate.name === toolName);
		if (tool === undefined) {
			return {
				status: "rejected",
				operation: "set",
				code: "UNKNOWN_TOOL",
				toolName,
				snapshot: this.snapshot(),
			};
		}

		const changed = this.enabledTools.has(toolName) !== enabled;
		if (enabled) this.enabledTools.add(toolName);
		else this.enabledTools.delete(toolName);
		this.commit(persist);
		const snapshot = this.snapshot();
		return {
			status: "applied",
			operation: "set",
			code: snapshot.empty ? "EMPTY_SELECTION" : changed ? "UPDATED" : "UNCHANGED",
			persisted: persist,
			snapshot,
		};
	}

	toggle(toolName: string, persist = true): ToolSelectionOperationOutcome {
		this.refreshTools();
		if (!this.allTools.some((tool) => tool.name === toolName)) {
			return {
				status: "rejected",
				operation: "toggle",
				code: "UNKNOWN_TOOL",
				toolName,
				snapshot: this.snapshot(),
			};
		}
		const result = this.set(toolName, !this.enabledTools.has(toolName), persist);
		if (result.status !== "applied") return result;
		return { ...result, operation: "toggle" };
	}

	async reset(input: ToolSelectionResetInput): Promise<ToolSelectionOperationOutcome> {
		const revision = ++this.restoreRevision;
		this.refreshTools();
		const defaults = await this.resolveDefaults(input.cwd, input.model, input.refreshConfig ?? false);
		if (revision !== this.restoreRevision) {
			return { status: "superseded", operation: "reset", snapshot: this.snapshot() };
		}

		const persist = input.persist ?? true;
		if (defaults.status === "error") {
			this.apply(this.allTools.map((tool) => tool.name));
			this.persist(persist);
			return {
				status: "degraded",
				operation: "reset",
				code: "CONFIG_ERROR",
				message: defaults.message,
				persisted: persist,
				snapshot: this.snapshot(),
			};
		}

		const previous = this.snapshot().enabledTools;
		this.apply(defaults.enabledTools);
		this.persist(persist);
		const snapshot = this.snapshot();
		return {
			status: "applied",
			operation: "reset",
			code: snapshot.empty
				? "EMPTY_SELECTION"
				: sameNames(previous, snapshot.enabledTools) ? "UNCHANGED" : "UPDATED",
			persisted: persist,
			snapshot,
		};
	}

	private refreshTools(): void {
		this.allTools = this.port.getAllTools();
		const available = new Set(this.allTools.map((tool) => tool.name));
		this.enabledTools = new Set([...this.enabledTools].filter((name) => available.has(name)));
	}

	private apply(names: readonly string[]): void {
		this.enabledTools = new Set(names);
		this.port.setActiveTools(this.snapshot().enabledTools);
	}

	private commit(persist: boolean): void {
		this.port.setActiveTools(this.snapshot().enabledTools);
		this.persist(persist);
	}

	private persist(enabled: boolean): void {
		if (!enabled) return;
		this.port.appendEntry(TOOL_SELECTION_ENTRY, { enabledTools: this.snapshot().enabledTools });
	}

	private async resolveDefaults(
		cwd: string,
		model: ToolDefaultsModel | undefined,
		refreshConfig: boolean,
	): Promise<{ status: "ready"; enabledTools: string[] } | { status: "error"; message: string }> {
		try {
			if (refreshConfig || this.configCache?.cwd !== cwd) {
				this.configCache = { cwd, value: this.loadConfig(cwd) };
			}
			const config = await this.configCache.value;
			const defaults = resolveToolDefaults(config, model);
			return {
				status: "ready",
				enabledTools: this.allTools
					.filter((tool) => defaults[tool.name] ?? true)
					.map((tool) => tool.name),
			};
		} catch (error) {
			return { status: "error", message: error instanceof Error ? error.message : String(error) };
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

function collectIssues(snapshot: ToolSelectionSnapshot, removedTools: readonly string[]): ToolSelectionIssue[] {
	const issues: ToolSelectionIssue[] = [];
	if (snapshot.empty) issues.push("EMPTY_SELECTION");
	if (removedTools.length > 0) issues.push("REMOVED_TOOLS");
	return issues;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
