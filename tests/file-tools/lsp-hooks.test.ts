import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileChangeType } from "vscode-languageserver-protocol";

import { editFile } from "../../src/file-tools/edit/command.js";
import { grepWorkspaceFiles } from "../helpers/grep-tool.js";
import { clearGrepTestRuntime as clearGrepIndex } from "../helpers/grep-tool.js";
import { FileToolsHost } from "../../src/file-tools/runtime/host.js";
import { piTextDiffGenerator } from "../../src/file-tools/pi/ports/text-diff.js";
import { createEditPorts } from "../../src/file-tools/pi/ports/edit.js";
import { createWritePorts } from "../../src/file-tools/pi/ports/write.js";
import { readWorkspaceFile } from "../helpers/read-tool.js";
import { writeFile as writeFileCommand } from "../../src/file-tools/write/command.js";
import type { ToolOutcome } from "../../src/file-tools/shared/result.js";
import type { GrepSuccess } from "../../src/file-tools/grep/types.js";
import { createLspFileOperations, type LspFileOperations } from "../../src/lsp/file-hooks.js";
import { LspManager } from "../../src/lsp/manager.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let workspace: string;
let outside: string;
let host: FileToolsHost;
const workspaceTemp = useTempDir("o-pi-lsp-hooks-");
const configTemp = useTempDir("o-pi-lsp-hooks-config-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(async () => {
	workspace = workspaceTemp.path;
	outside = configTemp.path;
	const config = path.join(outside, "file-tools.jsonc");
	await writeFile(config, JSON.stringify({ ignore: { builtin_profile: "none", gitignore: false } }));
	process.env.PI_FILE_TOOLS_CONFIG = config;
	host = new FileToolsHost();
});

afterEach(() => host.dispose());

describe("file-tools lsp hooks", () => {
	it("read 附加 partial enclosing symbol，hook 失败时仍成功", async () => {
		await writeFile(path.join(workspace, "a.ts"), "function demo() {\n  return 1;\n}\n");
		await expect(readWorkspaceFile(workspace, { path: "a.ts", start_line: 2, end_line: 2 }, {
			structure: {
				async context(input) {
					expect(input.partial).toBe(true);
					return { enclosing_symbol: { name: "demo", kind: "function", line: 1, end_line: 3 } };
				},
			},
		})).resolves.toMatchObject({
			path: "a.ts",
			lsp: { enclosing_symbol: { name: "demo" } },
		});

		await expect(readWorkspaceFile(workspace, { path: "a.ts", start_line: 2 }, {
			structure: { async context() { throw new Error("unavailable"); } },
		})).resolves.toMatchObject({ path: "a.ts" });
	});

	it("write 返回 diagnostics 但不改变 written 状态，并区分 create/change", async () => {
		const createdEvents: boolean[] = [];
		const hooks: LspFileOperations = {
			async afterWrite(input) {
				createdEvents.push(input.created);
				return diagnostics("errors");
			},
		};
		await expect(writeWithHooks({ path: "a.ts", content: "const x = 1;\n" }, hooks)).resolves.toMatchObject({
			status: "written",
			path: "a.ts",
			lsp: { diagnostics: { status: "errors", file_errors: 1 } },
		});
		await expect(writeWithHooks({ path: "a.ts", content: "const x = 2;\n" }, hooks)).resolves.toMatchObject({
			status: "written",
			action: "modify",
		});
		expect(createdEvents).toEqual([true, false]);
		await expect(writeWithHooks({ path: "b.ts", content: "" }, throwingHooks())).resolves.toMatchObject({ status: "written" });
	});

	it("edit 只在成功写盘后调用 diagnostics hook", async () => {
		await writeFile(path.join(workspace, "a.ts"), "const oldName = 1;\n");
		await readWorkspaceFile(workspace, { path: "a.ts" }, { host, sessionId: "lsp-hooks" });
		let afterCalled = false;
		const hooks: LspFileOperations = {
			async beforeEdit() {
				return { source: "/repo\0ts", uri: pathToFileURL("a.ts").toString(), items: [], known: true, revision: 1 };
			},
			async afterWrite(input) {
				afterCalled = true;
				expect(input.created).toBe(false);
				expect(input.baseline?.known).toBe(true);
				return diagnostics("warnings");
			},
		};
		await expect(editWithHooks({ path: "a.ts", edits: [{ old: "oldName", new: "newName" }] }, hooks)).resolves.toMatchObject({
			status: "applied",
			lsp: { diagnostics: { status: "warnings", file_warnings: 1 } },
		});
		expect(afterCalled).toBe(true);

		await expect(editWithHooks({ path: "a.ts", edits: [{ old: "missing", new: "x" }] }, hooks)).resolves.toMatchObject({ status: "failed" });
	});

	it("afterWrite 对无源码路由的配置文件仍转发 watched-file create/change", async () => {
		const manager = new LspManager();
		const watched = vi.spyOn(manager, "didChangeWatchedFile").mockResolvedValue();
		const diagnosticsAfterWrite = vi.spyOn(manager, "didWrite").mockResolvedValue(undefined);
		const hooks = createLspFileOperations(manager);
		const configFile = path.join(workspace, "tsconfig.json");

		await hooks.afterWrite?.({ workspaceRoot: workspace, filePath: configFile, content: "{}\n", created: true });
		await hooks.afterWrite?.({ workspaceRoot: workspace, filePath: configFile, content: "{\"compilerOptions\":{}}\n", created: false });

		expect(watched).toHaveBeenNthCalledWith(1, workspace, configFile, FileChangeType.Created);
		expect(watched).toHaveBeenNthCalledWith(2, workspace, configFile, FileChangeType.Changed);
		expect(diagnosticsAfterWrite).toHaveBeenCalledTimes(2);
	});

	it("afterWriteBatch 统一转发文件通知与 diagnostics，并保持结果顺序", async () => {
		const manager = new LspManager();
		const watched = vi.spyOn(manager, "didChangeWatchedFiles").mockResolvedValue();
		const first = diagnostics("errors");
		const second = diagnostics("warnings");
		const diagnosticsBatch = vi.spyOn(manager, "didWriteBatch").mockResolvedValue([first, second]);
		const hooks = createLspFileOperations(manager);
		const inputs = [
			{ workspaceRoot: workspace, filePath: path.join(workspace, "a.ts"), content: "a\n", created: true },
			{ workspaceRoot: workspace, filePath: path.join(workspace, "b.ts"), content: "b\n", created: false },
		];

		await expect(hooks.afterWriteBatch?.(inputs)).resolves.toEqual([first, second]);
		expect(watched).toHaveBeenCalledTimes(1);
		expect(watched).toHaveBeenCalledWith([
			{ root: workspace, filePath: path.join(workspace, "a.ts"), type: FileChangeType.Created },
			{ root: workspace, filePath: path.join(workspace, "b.ts"), type: FileChangeType.Changed },
		]);
		expect(diagnosticsBatch).toHaveBeenCalledTimes(1);
		expect(diagnosticsBatch).toHaveBeenCalledWith([
			{ root: workspace, filePath: path.join(workspace, "a.ts"), text: "a\n" },
			{ root: workspace, filePath: path.join(workspace, "b.ts"), text: "b\n" },
		]);
	});

	it("beforeEdit 使用调用方已解析的 absolutePath 和 workspace source", async () => {
		const manager = new LspManager();
		const beforeDiagnostics = vi.spyOn(manager, "beforeDiagnostics").mockResolvedValue(undefined);
		const hooks = createLspFileOperations(manager);
		const absolutePath = path.join(workspace, "resolved.ts");
		await hooks.beforeEdit?.({ workspaceRoot: workspace, filePath: absolutePath });
		expect(beforeDiagnostics).toHaveBeenCalledWith(workspace, absolutePath);
		beforeDiagnostics.mockRestore();
	});

	it("grep 合入 LSP symbol 候选且不绕过 path scope", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "target.ts"), "export const unrelated = 1;\n");
		await writeFile(path.join(workspace, "outside.ts"), "export const other = 1;\n");
		let seenPaths: string[] = [];
		const hooks: LspFileOperations = {
			async symbols(input) {
				seenPaths = [...input.allowedPaths];
				return [
					{ path: "src/target.ts", start_line: 1, end_line: 1, kind: "variable", symbol: "RemoteSymbol", exact: true, origin: "workspace-symbol" },
					{ path: "outside.ts", start_line: 1, end_line: 1, kind: "variable", symbol: "RemoteSymbol", exact: true, origin: "workspace-symbol" },
				];
			},
		};
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ["src"], query: "RemoteSymbol" }, undefined, { lsp: hooks }));
		expect(result.regions).toHaveLength(1);
		expect(result.regions[0]).toMatchObject({ path: "src/target.ts", symbol: "RemoteSymbol", reasons: ["lsp exact symbol"] });
		expect(seenPaths).toEqual(["src/target.ts"]);

		await expect(grepWorkspaceFiles(workspace, { path: ["src"], query: "RemoteSymbol" }, undefined, { lsp: throwingHooks() })).resolves.toMatchObject({ status: "success" });
	});

	it("grep 为混合和空 scope 传递 ignore/glob 过滤后的实际路径", async () => {
		await mkdir(path.join(workspace, "mixed"));
		await writeFile(path.join(workspace, "mixed", "a.ts"), "export const target = 1;\n");
		await writeFile(path.join(workspace, "mixed", "b.py"), "target = 1\n");
		const seenPaths: string[][] = [];
		const seenSignals: Array<AbortSignal | undefined> = [];
		const hooks: LspFileOperations = {
			async symbols(input) {
				seenPaths.push([...input.allowedPaths].sort());
				seenSignals.push(input.signal);
				return [];
			},
		};
		const controller = new AbortController();
		await grepWorkspaceFiles(workspace, { path: ["mixed"], query: "Target" }, controller.signal, { lsp: hooks });
		await grepWorkspaceFiles(workspace, { path: ["mixed"], query: "Target", glob: "*.ts" }, undefined, { lsp: hooks });
		await mkdir(path.join(workspace, "empty"));
		await grepWorkspaceFiles(workspace, { path: ["empty"], query: "Target" }, undefined, { lsp: hooks });
		expect(seenPaths).toEqual([
			["mixed/a.ts", "mixed/b.py"],
			["mixed/a.ts"],
			[],
		]);
		expect(seenSignals).toHaveLength(3);
		expect(seenSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
	});

	it("grep 并行请求 LSP 与 Repo Map", async () => {
		await writeFile(path.join(workspace, "target.ts"), "export const target = 1;\n");
		let active = 0;
		let maxActive = 0;
		const pause = async (): Promise<void> => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>((resolve) => setImmediate(resolve));
			active -= 1;
		};

		await grepWorkspaceFiles(workspace, { query: "RemoteSymbol" }, undefined, {
			lsp: { async symbols() { await pause(); return []; } },
			repoMap: {
				async query() { await pause(); return undefined; },
				async readContext() { return undefined; },
				async syncMutation() { return undefined; },
			},
		});

		expect(maxActive).toBe(2);
	});

	it("LSP 语义排序不依赖服务器顺序，非显式 reference 进入 related", async () => {
		for (const name of ["exact", "prefix", "reference"]) {
			await writeFile(path.join(workspace, `${name}.ts`), `export const ${name} = 1;\n`);
		}
		const candidates = [
			{ path: "reference.ts", start_line: 1, end_line: 1, kind: "variable", symbol: "Target", exact: true, origin: "reference" as const },
			{ path: "prefix.ts", start_line: 1, end_line: 1, kind: "variable", symbol: "TargetHelper", exact: false, origin: "workspace-symbol" as const },
			{ path: "exact.ts", start_line: 1, end_line: 1, kind: "variable", symbol: "Target", exact: true, origin: "workspace-symbol" as const },
		];
		const first = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "Target" }, undefined, {
			lsp: { async symbols() { return candidates; } },
		}));
		clearGrepIndex();
		const second = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "Target" }, undefined, {
			lsp: { async symbols() { return [...candidates].reverse(); } },
		}));
		const order = (result: GrepSuccess) => result.regions.map((region) => `${region.path}:${region.reasons[0]}`);
		expect(order(first)).toEqual(order(second));
		expect(order(first)).toEqual([
			"exact.ts:lsp exact symbol",
			"prefix.ts:lsp symbol",
		]);
		expect(first.regions.find((region) => region.path === "exact.ts")?.sources).toContain("lsp-symbol");
		expect(first.related).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: "reference.ts", sources: ["lsp-reference"], relations: ["reference"] }),
		]));
	});
});

async function writeWithHooks(params: { path: string; content: string }, hooks: LspFileOperations) {
	const opened = await host.open({ cwd: workspace, sessionId: "lsp-hooks" });
	if ("status" in opened) return opened;
	try {
		const ports = createWritePorts(opened, hooks, inactiveRepoMap);
		return await writeFileCommand(params, {
			filesystem: opened.filesystem,
			operation: opened.context,
			maxFileBytes: opened.limits.write_max_file_bytes,
			diff: piTextDiffGenerator,
			diagnostics: ports.diagnostics,
		});
	} finally {
		opened.dispose();
	}
}

async function editWithHooks(params: { path: string; edits: Array<{ old: string; new: string }> }, hooks: LspFileOperations) {
	const opened = await host.open({ cwd: workspace, sessionId: "lsp-hooks" });
	if ("status" in opened) return opened;
	try {
		const ports = createEditPorts(opened, hooks, inactiveRepoMap);
		return await editFile(params, {
			filesystem: opened.filesystem,
			operation: opened.context,
			observation: opened.observation,
			maxFileBytes: opened.limits.edit_max_file_bytes,
			matchHintLimit: opened.limits.edit_match_hint_limit,
			diff: piTextDiffGenerator,
			diagnostics: ports.diagnostics,
		});
	} finally {
		opened.dispose();
	}
}

const inactiveRepoMap = {
	query: {
		async query() { return undefined; },
		async readContext() { return undefined; },
		async syncMutation() { return undefined; },
	},
	async formatReadContext() { return undefined; },
	async formatImpact() { return undefined; },
	async syncMutation() {},
};

function diagnostics(status: "errors" | "warnings") {
	return {
		status,
		file_errors: status === "errors" ? 1 : 0,
		file_warnings: status === "warnings" ? 1 : 0,
		new_errors: 0,
		new_warnings: 0,
		resolved_errors: 0,
		resolved_warnings: 0,
		baseline: "known" as const,
		total_items: 1,
		items: [{ severity: status === "errors" ? "error" as const : "warning" as const, line: 1, column: 1, message: "diagnostic" }],
	};
}

function throwingHooks(): LspFileOperations {
	return {
		async read() {
			throw new Error("lsp unavailable");
		},
		async afterWrite() {
			throw new Error("lsp timeout");
		},
		async beforeEdit() {
			throw new Error("lsp unavailable");
		},
		async symbols() {
			throw new Error("lsp unavailable");
		},
	};
}

function expectGrepSuccess(result: ToolOutcome<GrepSuccess>): GrepSuccess {
	if (result.status === "failed") throw new Error(result.error.message);
	return result;
}
