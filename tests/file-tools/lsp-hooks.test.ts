import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileChangeType } from "vscode-languageserver-protocol";

import { editFile } from "../../src/file-tools/edit/command.js";
import { grepWorkspaceFiles } from "../helpers/grep-tool.js";
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
	it("read 只为整文件截断请求 outline fallback", async () => {
		const manager = new LspManager();
		const enhancement = vi.spyOn(manager, "readEnhancement").mockResolvedValue(undefined);
		const read = createLspFileOperations(manager).read;
		if (read === undefined) throw new Error("read operation missing");
		const base = {
			workspaceRoot: workspace,
			filePath: path.join(workspace, "a.ts"),
			content: "const value = 1;\n",
			startLine: 1,
			endLine: 1,
		};

		await read({ ...base, truncated: true, partial: true });
		await read({ ...base, truncated: false, partial: false });
		await read({ ...base, truncated: true, partial: false });

		expect(enhancement).toHaveBeenNthCalledWith(1, workspace, path.join(workspace, "a.ts"), base.content, { startLine: 1, endLine: 1 }, { outline: false, enclosing: true });
		expect(enhancement).toHaveBeenNthCalledWith(2, workspace, path.join(workspace, "a.ts"), base.content, { startLine: 1, endLine: 1 }, { outline: false, enclosing: false });
		expect(enhancement).toHaveBeenNthCalledWith(3, workspace, path.join(workspace, "a.ts"), base.content, { startLine: 1, endLine: 1 }, { outline: true, enclosing: false });
	});

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
				expect(input.changed_ranges).toEqual([{ start_line: 1, end_line: 1 }]);
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

	it("grep 本地零结果的普通 symbol 查询不启动 LSP", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "target.ts"), "export const unrelated = 1;\n");
		const symbols = vi.fn(async () => []);
		const hooks: LspFileOperations = {
			symbols,
		};
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ["src"], query: "RemoteSymbol" }, undefined, { lsp: hooks }));
		expect(result.regions).toEqual([]);
		expect(symbols).not.toHaveBeenCalled();
	});

	it("grep 只为本地不足的关系查询向 LSP 传递过滤后的实际路径", async () => {
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
		await grepWorkspaceFiles(workspace, { path: ["mixed"], query: "references to MissingTarget" }, controller.signal, { lsp: hooks });
		await grepWorkspaceFiles(workspace, { path: ["mixed"], query: "references to MissingTarget", glob: "*.ts" }, undefined, { lsp: hooks });
		await mkdir(path.join(workspace, "empty"));
		await grepWorkspaceFiles(workspace, { path: ["empty"], query: "references to MissingTarget" }, undefined, { lsp: hooks });
		expect(seenPaths).toEqual([
			["mixed/a.ts", "mixed/b.py"],
			["mixed/a.ts"],
			[],
		]);
		expect(seenSignals).toHaveLength(3);
		expect(seenSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
	});

});

async function writeWithHooks(params: { path: string; content: string }, hooks: LspFileOperations) {
	const opened = await host.open({ cwd: workspace, sessionId: "lsp-hooks" });
	if ("status" in opened) return opened;
	try {
		const ports = createWritePorts(opened, hooks);
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
		const ports = createEditPorts(opened, hooks);
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
