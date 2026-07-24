import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { editWorkspace } from "../../src/file-tools/tools/edit.js";
import { grepWorkspaceFiles } from "../../src/file-tools/tools/grep.js";
import { clearGrepIndex } from "../../src/file-tools/grep/indexer.js";
import { ReadVersionCache } from "../../src/file-tools/core/read-cache.js";
import { readWorkspaceFile } from "../../src/file-tools/tools/read.js";
import { writeWorkspaceFile } from "../../src/file-tools/tools/write.js";
import type { FileToolLspHooks, GrepSuccess, ToolOutcome } from "../../src/file-tools/types.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let workspace: string;
let outside: string;
const workspaceTemp = useTempDir("o-pi-lsp-hooks-");
const configTemp = useTempDir("o-pi-lsp-hooks-config-");
preserveEnv("PI_FILE_TOOLS_CONFIG");

beforeEach(async () => {
	workspace = workspaceTemp.path;
	outside = configTemp.path;
	const config = path.join(outside, "file-tools.jsonc");
	await writeFile(config, JSON.stringify({ ignore: { builtin_profile: "none", gitignore: false } }));
	process.env.PI_FILE_TOOLS_CONFIG = config;
});

describe("file-tools lsp hooks", () => {
	it("read 附加 partial enclosing symbol，hook 失败时仍成功", async () => {
		await writeFile(path.join(workspace, "a.ts"), "function demo() {\n  return 1;\n}\n");
		const hooks: FileToolLspHooks = {
			async enhanceRead(input) {
				expect(input.partial).toBe(true);
				return { enclosing_symbol: { name: "demo", kind: "function", line: 1, end_line: 3 } };
			},
		};
		await expect(readWorkspaceFile(workspace, { path: "a.ts", start_line: 2, end_line: 2 }, { lsp: hooks })).resolves.toMatchObject({
			path: "a.ts",
			lsp: { enclosing_symbol: { name: "demo" } },
		});

		await expect(readWorkspaceFile(workspace, { path: "a.ts" }, { lsp: throwingHooks() })).resolves.toMatchObject({ path: "a.ts" });
	});

	it("write 返回 diagnostics 但不改变 written 状态", async () => {
		const hooks: FileToolLspHooks = {
			async afterWrite() {
				return diagnostics("errors");
			},
		};
		await expect(writeWorkspaceFile(workspace, { path: "a.ts", content: "const x = 1;\n" }, undefined, { lsp: hooks })).resolves.toMatchObject({
			status: "written",
			path: "a.ts",
			lsp: { diagnostics: { status: "errors", file_errors: 1 } },
		});
		await expect(writeWorkspaceFile(workspace, { path: "b.ts", content: "" }, undefined, { lsp: throwingHooks() })).resolves.toMatchObject({ status: "written" });
	});

	it("edit 只在成功写盘后调用 diagnostics hook", async () => {
		await writeFile(path.join(workspace, "a.ts"), "const oldName = 1;\n");
		const cache = new ReadVersionCache();
		await readWorkspaceFile(workspace, { path: "a.ts" }, { versionCache: cache });
		let afterCalled = false;
		const hooks: FileToolLspHooks = {
			async beforeEdit() {
				return { uri: "file:///a.ts", items: [], known: true };
			},
			async afterEdit(input) {
				afterCalled = true;
				expect(input.baseline?.known).toBe(true);
				return diagnostics("warnings");
			},
		};
		await expect(editWorkspace(workspace, { path: "a.ts", edits: [{ old: "oldName", new: "newName" }] }, { versionCache: cache, lsp: hooks })).resolves.toMatchObject({
			status: "applied",
			lsp: { diagnostics: { status: "warnings", file_warnings: 1 } },
		});
		expect(afterCalled).toBe(true);

		await expect(editWorkspace(workspace, { path: "a.ts", edits: [{ old: "missing", new: "x" }] }, { versionCache: cache, lsp: hooks })).resolves.toMatchObject({ status: "failed" });
	});

	it("grep 合入 LSP symbol 候选且不绕过 path scope", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "target.ts"), "export const unrelated = 1;\n");
		await writeFile(path.join(workspace, "outside.ts"), "export const other = 1;\n");
		let seenExtensions: readonly string[] = [];
		const hooks: FileToolLspHooks = {
			async grepSymbols(input) {
				seenExtensions = input.extensions;
				return [
					{ path: "src/target.ts", start_line: 1, end_line: 1, kind: "variable", symbol: "RemoteSymbol", reason: "lsp exact symbol" },
					{ path: "outside.ts", start_line: 1, end_line: 1, kind: "variable", symbol: "RemoteSymbol", reason: "lsp exact symbol" },
				];
			},
		};
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ["src"], query: "RemoteSymbol" }, undefined, { lsp: hooks }));
		expect(result.regions).toHaveLength(1);
		expect(result.regions[0]).toMatchObject({ path: "src/target.ts", symbol: "RemoteSymbol", reasons: ["lsp exact symbol"] });
		expect(seenExtensions).toEqual([".ts"]);

		await expect(grepWorkspaceFiles(workspace, { path: ["src"], query: "RemoteSymbol" }, undefined, { lsp: throwingHooks() })).resolves.toMatchObject({ status: "success" });
	});

	it("grep 为混合和空 scope 传递实际扩展名集合", async () => {
		await mkdir(path.join(workspace, "mixed"));
		await writeFile(path.join(workspace, "mixed", "a.ts"), "export const target = 1;\n");
		await writeFile(path.join(workspace, "mixed", "b.py"), "target = 1\n");
		const seen: string[][] = [];
		const hooks: FileToolLspHooks = {
			async grepSymbols(input) {
				seen.push([...input.extensions]);
				return [];
			},
		};
		await grepWorkspaceFiles(workspace, { path: ["mixed"], query: "Target" }, undefined, { lsp: hooks });
		await mkdir(path.join(workspace, "empty"));
		await grepWorkspaceFiles(workspace, { path: ["empty"], query: "Target" }, undefined, { lsp: hooks });
		expect(seen).toEqual([[".py", ".ts"], []]);
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
			lsp: { async grepSymbols() { await pause(); return []; } },
			repoMap: {
				async query() { await pause(); return undefined; },
				async readContext() { return undefined; },
				async syncMutation() { return undefined; },
			},
		});

		expect(maxActive).toBe(2);
	});

	it("LSP 显式语义排序不依赖服务器顺序，并把 reference 放在 workspace symbol 后", async () => {
		for (const name of ["exact", "prefix", "reference"]) {
			await writeFile(path.join(workspace, `${name}.ts`), `export const ${name} = 1;\n`);
		}
		const candidates = [
			{ path: "reference.ts", start_line: 1, end_line: 1, kind: "variable", symbol: "Target", reason: "lsp reference" as const, origin: "reference" as const },
			{ path: "prefix.ts", start_line: 1, end_line: 1, kind: "variable", symbol: "TargetHelper", reason: "lsp symbol" as const, origin: "workspace-symbol" as const },
			{ path: "exact.ts", start_line: 1, end_line: 1, kind: "variable", symbol: "Target", reason: "lsp exact symbol" as const, origin: "workspace-symbol" as const },
		];
		const first = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "Target" }, undefined, {
			lsp: { async grepSymbols() { return candidates; } },
		}));
		clearGrepIndex();
		const second = expectGrepSuccess(await grepWorkspaceFiles(workspace, { query: "Target" }, undefined, {
			lsp: { async grepSymbols() { return [...candidates].reverse(); } },
		}));
		const order = (result: GrepSuccess) => result.regions.map((region) => `${region.path}:${region.reasons[0]}`);
		expect(order(first)).toEqual(order(second));
		expect(order(first)).toEqual([
			"exact.ts:lsp exact symbol",
			"prefix.ts:lsp symbol",
			"reference.ts:lsp reference",
		]);
		expect(first.regions.find((region) => region.path === "exact.ts")?.sources).toContain("lsp-workspace-symbol");
		expect(first.regions.find((region) => region.path === "reference.ts")?.sources).toContain("lsp-reference");
	});
});

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

function throwingHooks(): FileToolLspHooks {
	return {
		async enhanceRead() {
			throw new Error("lsp unavailable");
		},
		async afterWrite() {
			throw new Error("lsp timeout");
		},
		async beforeEdit() {
			throw new Error("lsp unavailable");
		},
		async afterEdit() {
			throw new Error("lsp unavailable");
		},
		async grepSymbols() {
			throw new Error("lsp unavailable");
		},
	};
}

function expectGrepSuccess(result: ToolOutcome<GrepSuccess>): GrepSuccess {
	if (result.status === "failed") throw new Error(result.error.message);
	return result;
}
