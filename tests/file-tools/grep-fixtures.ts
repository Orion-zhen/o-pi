import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect } from "vitest";

import type { ContentOperations } from "../../src/filesystem/contracts/content.js";
import type { WorkspaceFileSystem } from "../../src/filesystem/contracts/workspace.js";
import { clearGrepTestRuntime as clearGrepIndex } from "../helpers/grep-tool.js";
import { buildScopeInventory, type ScopeInventory } from "../../src/file-tools/grep/inventory.js";
import { GrepTool } from "../../src/file-tools/grep/command.js";
import type { AnalyzeCode, PrepareCodeAnalysis } from "../../src/code-index/types.js";
import type { GrepSuccess } from "../../src/file-tools/grep/types.js";
import { FileToolsHost, type FileToolsInvocation } from "../../src/file-tools/runtime/host.js";
import { isFailed, type ToolOutcome } from "../../src/file-tools/shared/result.js";
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
					grep_result_limit: 8,
					grep_related_result_limit: 8,
					grep_regional_display_limit: 3,
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
	return expectSuccess(result);
}

export function expectInventorySuccess(result: ToolOutcome<ScopeInventory>): ScopeInventory {
	return expectSuccess(result);
}

export function expectSuccess<T>(result: ToolOutcome<T>): T {
	if (isFailed(result)) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result;
}

export async function withFileToolsInvocation<T>(
	workspace: string,
	sessionId: string,
	run: (opened: FileToolsInvocation) => Promise<T>,
): Promise<T> {
	const host = new FileToolsHost();
	let opened: FileToolsInvocation | undefined;
	try {
		opened = expectSuccess(await host.open({ cwd: workspace, sessionId }));
		return await run(opened);
	} finally {
		opened?.dispose();
		host.dispose();
	}
}

export async function withGrepRuntime<T>(
	workspace: string,
	sessionId: string,
	run: (runtime: { readonly tool: GrepTool; readonly opened: FileToolsInvocation }) => Promise<T>,
): Promise<T> {
	const host = new FileToolsHost();
	const tool = new GrepTool();
	let opened: FileToolsInvocation | undefined;
	try {
		opened = expectSuccess(await host.open({ cwd: workspace, sessionId }));
		return await run({ tool, opened });
	} finally {
		tool.dispose();
		opened?.dispose();
		host.dispose();
	}
}

export function overrideContent(
	filesystem: WorkspaceFileSystem,
	build: (content: ContentOperations) => Partial<ContentOperations>,
): WorkspaceFileSystem {
	const content = filesystem.content;
	return {
		...filesystem,
		content: {
			readBytes: content.readBytes.bind(content),
			readText: content.readText.bind(content),
			decodeText: content.decodeText.bind(content),
			sliceText: content.sliceText.bind(content),
			scanLines: content.scanLines.bind(content),
			...build(content),
		},
	};
}

export async function grepWithAnalyzer(
	workspace: string,
	params: Parameters<GrepTool["execute"]>[0],
	sources: { readonly prepareCodeAnalysis?: PrepareCodeAnalysis; readonly analyzeCode?: AnalyzeCode },
	mapFilesystem: (filesystem: WorkspaceFileSystem) => WorkspaceFileSystem = (filesystem) => filesystem,
): Promise<ToolOutcome<GrepSuccess>> {
	const host = new FileToolsHost();
	const tool = new GrepTool();
	const opened = await host.open({ cwd: workspace, sessionId: "grep-analyzer" });
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
				...(sources.prepareCodeAnalysis === undefined ? {} : { prepareCodeAnalysis: sources.prepareCodeAnalysis }),
				...(sources.analyzeCode === undefined ? {} : { analyzeCode: sources.analyzeCode }),
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
	maxSearchBytes = Number.MAX_SAFE_INTEGER,
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
			maxEntries: 100_000,
			maxSearchBytes,
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

export async function assertStrictMatches(workspace: string, result: GrepSuccess, query: string): Promise<void> {
	for (const region of result.regions) {
		const text = await readFile(path.join(workspace, region.path), "utf8");
		const lines = text.split(/\n/u);
		expect(region.match_lines?.length).toBeGreaterThan(0);
		for (const lineNumber of region.match_lines ?? []) {
			const line = lines[lineNumber - 1] ?? "";
			expect(result.query_mode === "literal_fallback" ? line.includes(query) : new RegExp(query, "u").test(line)).toBe(true);
		}
	}
}

export function deferredVoid(): { readonly promise: Promise<void>; resolve(): void } {
	let resolver: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => { resolver = resolve; });
	return { promise, resolve() { resolver?.(); } };
}
