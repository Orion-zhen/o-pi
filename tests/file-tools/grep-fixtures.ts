import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect } from "vitest";

import type { IndexedCodeUnit } from "../../src/code-index/parser.js";
import type { WorkspaceFileSystem } from "../../src/filesystem/contracts/workspace.js";
import { clearGrepTestRuntime as clearGrepIndex } from "../helpers/grep-tool.js";
import { buildScopeInventory, type ScopeInventory } from "../../src/file-tools/grep/inventory.js";
import { GrepTool } from "../../src/file-tools/grep/command.js";
import type { GrepGraphSource, GrepSymbolSource } from "../../src/file-tools/grep/ports.js";
import type { GrepMatchMode, GrepSuccess } from "../../src/file-tools/grep/types.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { isFailed, type ToolOutcome } from "../../src/file-tools/shared/result.js";
import type { RepoMapFileToolQuery } from "../../src/repo-map/query/file-tool-query.js";
import type { RepoMapQueryCandidate } from "../../src/repo-map/query/query.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

export interface GrepTestContext {
	readonly workspace: string;
	readonly outside: string;
}

export function createGrepTestContext(): GrepTestContext {
	const workspaceTemp = useTempDir("o-pi-grep-");
	const outsideTemp = useTempDir("o-pi-grep-outside-");
	preserveEnv("PI_FILE_TOOLS_CONFIG");

	beforeEach(async () => {
		const configPath = path.join(outsideTemp.path, "file-tools.jsonc");
		await writeConfig(configPath);
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		clearGrepIndex();
	});

	afterEach(() => {
		clearGrepIndex();
	});

	return {
		get workspace() { return workspaceTemp.path; },
		get outside() { return outsideTemp.path; },
	};
}

export async function writeConfig(configPath: string, limits: Record<string, number> = {}): Promise<void> {
	await writeFile(
		configPath,
		JSON.stringify(
			{
				blocked_path: [".git/"],
				ignored_path: [],
				ignore: { builtin_profile: "none", gitignore: false },
				limits: {
					grep_output_token_budget: 1600,
					grep_result_limit: 8,
					grep_max_depth: 12,
					grep_ast_max_file_bytes: 4096,
					...limits,
				},
			},
			null,
			2,
		),
	);
}

export function expectGrepSuccess(result: ToolOutcome<GrepSuccess>): GrepSuccess {
	if (result.status === "failed") throw new Error(`grep failed: ${result.error.code}: ${result.error.message}`);
	return result;
}

export function expectInventorySuccess(result: ToolOutcome<ScopeInventory>): ScopeInventory {
	if (isFailed(result)) throw new Error(`inventory failed: ${result.error.code}: ${result.error.message}`);
	return result;
}

export async function grepWithSources(
	workspace: string,
	params: Parameters<GrepTool["execute"]>[0],
	sources: { readonly symbols?: GrepSymbolSource; readonly graph?: GrepGraphSource },
	mapFilesystem: (filesystem: WorkspaceFileSystem) => WorkspaceFileSystem = (filesystem) => filesystem,
): Promise<ToolOutcome<GrepSuccess>> {
	const host = new FileToolsHost();
	const tool = new GrepTool();
	const opened = await host.open({ cwd: workspace, sessionId: "grep-external" });
	if (isFailed(opened)) {
		tool.dispose();
		host.dispose();
		return opened;
	}
	try {
		return await tool.execute(params, {
			filesystem: mapFilesystem(opened.filesystem),
			operation: opened.context,
			limits: opened.limits,
			...(sources.symbols === undefined ? {} : { symbols: sources.symbols }),
			...(sources.graph === undefined ? {} : { graph: sources.graph }),
		});
	} finally {
		tool.dispose();
		opened.dispose();
		host.dispose();
	}
}

export async function inventoryWorkspace(
	workspace: string,
	params: { readonly paths: readonly string[]; readonly glob?: string },
	maxDepth = 12,
	mapFilesystem: (filesystem: WorkspaceFileSystem) => WorkspaceFileSystem = (filesystem) => filesystem,
): Promise<ToolOutcome<ScopeInventory>> {
	const host = new FileToolsHost();
	const opened = await host.open({ cwd: workspace, sessionId: "grep-inventory" });
	if (isFailed(opened)) {
		host.dispose();
		return opened;
	}
	try {
		return await buildScopeInventory(params, {
			filesystem: mapFilesystem(opened.filesystem),
			operation: opened.context,
			maxDepth,
		});
	} finally {
		opened.dispose();
		host.dispose();
	}
}

export function firstRegion(result: GrepSuccess) {
	const region = result.regions[0];
	if (region === undefined) throw new Error("missing region");
	return region;
}

export async function assertStrictMatches(workspace: string, result: GrepSuccess, query: string, match: Exclude<GrepMatchMode, "auto">): Promise<void> {
	for (const region of result.regions) {
		const text = await readFile(path.join(workspace, region.path), "utf8");
		const lines = text.split(/\n/u);
		expect(region.match_lines?.length).toBeGreaterThan(0);
		for (const lineNumber of region.match_lines ?? []) {
			const line = lines[lineNumber - 1] ?? "";
			expect(match === "literal" ? line.includes(query) : new RegExp(query, "u").test(line)).toBe(true);
		}
	}
}

export function deferredVoid(): { readonly promise: Promise<void>; resolve(): void } {
	let resolver: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => { resolver = resolve; });
	return { promise, resolve() { resolver?.(); } };
}

export function repoMapCandidate(
	filePath: string,
	content: string,
	unit: IndexedCodeUnit,
	reasons: RepoMapQueryCandidate["reasons"],
	contentHash = createHash("sha256").update(content).digest("hex"),
): RepoMapQueryCandidate {
	return {
		path: filePath,
		fileId: `file:${filePath}`,
		contentHash,
		symbol: {
			id: unit.id,
			kind: unit.kind,
			...(unit.name !== undefined ? { name: unit.name } : {}),
			...(unit.qualifiedName !== undefined ? { qualifiedName: unit.qualifiedName } : {}),
			...(unit.signature !== undefined ? { signature: unit.signature } : {}),
			range: {
				startLine: unit.startLine,
				endLine: unit.endLine,
				startByte: unit.startByte,
				endByte: unit.endByte,
			},
		},
		range: {
			startLine: unit.startLine,
			endLine: unit.endLine,
			startByte: unit.startByte,
			endByte: unit.endByte,
		},
		score: 900,
		confidence: 1,
		hop: 0,
		reasons,
		matchedAliases: [],
		relatedEdges: [],
	};
}

export function repoMapQuery(query: RepoMapFileToolQuery["query"]): RepoMapFileToolQuery {
	return {
		query,
		async readContext() { return undefined; },
		async syncMutation() { return undefined; },
	};
}
