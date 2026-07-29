import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import fileTools from "../../agent/extensions/file-tools.js";
import { lspFileOperations as lspFileHooks } from "../../src/lsp/index.js";
import type { DiagnosticsSummary } from "../../src/file-tools/shared/diagnostics.js";
import { executeTool, type ExecuteResult, type ExecuteTool, type LifecycleHandler } from "./extension-fixture.js";

const cleanDiagnostics: DiagnosticsSummary = {
	status: "clean",
	file_errors: 0,
	file_warnings: 0,
	new_errors: 0,
	new_warnings: 0,
	resolved_errors: 0,
	resolved_warnings: 0,
	baseline: "unknown",
	total_items: 0,
	items: [],
};

describe("file-tools extension mutation progress", () => {
	it("edit/write 在提交前报告实时 diff，并报告 LSP 后处理状态", async () => {
		const registered: Array<{ name: string; execute?: ExecuteTool }> = [];
		const handlers = new Map<string, LifecycleHandler>();
		fileTools({
			registerTool(tool: { name: string; execute?: ExecuteTool }) { registered.push(tool); },
			on(name: string, handler: LifecycleHandler) { handlers.set(name, handler); },
		} as unknown as ExtensionAPI);

		const cwd = await mkdtemp(join(tmpdir(), "o-pi-mutation-progress-"));
		const ctx = { cwd, sessionManager: { getSessionId: () => "mutation-progress" } };
		const originalAfterWrite = lspFileHooks.afterWrite;
		try {
			let releaseWrite: (() => void) | undefined;
			const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
			let writeAtDiagnostics: string | undefined;
			lspFileHooks.afterWrite = async () => {
				writeAtDiagnostics = await readFile(join(cwd, "a.ts"), "utf8");
				await writeGate;
				return cleanDiagnostics;
			};
			const writeUpdates: ExecuteResult[] = [];
			const pendingWrite = executeTool(
				registered,
				"write",
				{ path: "a.ts", content: "const value = 1;\n" },
				ctx,
				undefined,
				(update) => writeUpdates.push(update),
			);
			await vi.waitFor(() => {
				expect(writeUpdates).toEqual(expect.arrayContaining([
					expect.objectContaining({ details: expect.objectContaining({ status: "writing", diff: expect.stringContaining("+1 const value = 1;") }) }),
					expect.objectContaining({ details: expect.objectContaining({ status: "post-processing", lsp: { status: "running", errors: 0, warnings: 0 } }) }),
				]));
				expect(writeAtDiagnostics).toBe("const value = 1;\n");
			});
			releaseWrite?.();
			await expect(pendingWrite).resolves.toMatchObject({ details: { status: "written", lsp: { diagnostics: { status: "clean" } } } });
			expect(writeUpdates).toEqual(expect.arrayContaining([
				expect.objectContaining({ details: expect.objectContaining({ status: "post-processing", lsp: { status: "clean", errors: 0, warnings: 0 } }) }),
			]));

			await executeTool(registered, "read", { path: "a.ts" }, ctx);
			let releaseEdit: (() => void) | undefined;
			const editGate = new Promise<void>((resolve) => { releaseEdit = resolve; });
			let editAtDiagnostics: string | undefined;
			lspFileHooks.afterWrite = async () => {
				editAtDiagnostics = await readFile(join(cwd, "a.ts"), "utf8");
				await editGate;
				return cleanDiagnostics;
			};
			const editUpdates: ExecuteResult[] = [];
			const pendingEdit = executeTool(
				registered,
				"edit",
				{ path: "a.ts", edits: [{ old: "value = 1", new: "value = 2" }] },
				ctx,
				undefined,
				(update) => editUpdates.push(update),
			);
			await vi.waitFor(() => {
				expect(editUpdates).toEqual(expect.arrayContaining([
					expect.objectContaining({ details: expect.objectContaining({ status: "editing", replacements: 1, diff: expect.stringContaining("+1 const value = 2;") }) }),
					expect.objectContaining({ details: expect.objectContaining({ status: "post-processing", replacements: 1, lsp: { status: "running", errors: 0, warnings: 0 } }) }),
				]));
				expect(editAtDiagnostics).toBe("const value = 2;\n");
			});
			releaseEdit?.();
			await expect(pendingEdit).resolves.toMatchObject({ details: { status: "applied", lsp: { diagnostics: { status: "clean" } } } });
			expect(editUpdates).toEqual(expect.arrayContaining([
				expect.objectContaining({ details: expect.objectContaining({ status: "post-processing", lsp: { status: "clean", errors: 0, warnings: 0 } }) }),
			]));

			const failedUpdates: ExecuteResult[] = [];
			await expect(executeTool(
				registered,
				"write",
				{ path: ".", content: "invalid" },
				ctx,
				undefined,
				(update) => failedUpdates.push(update),
			)).resolves.toMatchObject({ details: { status: "failed" } });
			expect(failedUpdates).toEqual([]);
		} finally {
			if (originalAfterWrite === undefined) delete lspFileHooks.afterWrite;
			else lspFileHooks.afterWrite = originalAfterWrite;
			await Promise.resolve(handlers.get("session_shutdown")?.({}, {}));
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
