import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import fileTools from "../../agent/extensions/file-tools.js";
import { lspFileOperations as lspFileHooks } from "../../src/lsp/index.js";
import type { DiagnosticsSummary } from "../../src/file-tools/shared/diagnostics.js";
import { registerExtension } from "../helpers/extension.js";
import { useTempDir } from "../helpers/lifecycle.js";
import { executeTool, type ExecuteResult } from "./extension-fixture.js";

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
	const workspace = useTempDir("o-pi-mutation-progress-");

	it("edit/write 在提交前报告实时 diff，并报告 LSP 后处理状态", async () => {
		const { registered, handlers } = registerExtension(fileTools);
		const cwd = workspace.path;
		const ctx = { cwd, sessionManager: { getSessionId: () => "mutation-progress", getBranch: () => [] } };
		const originalAfterMutation = lspFileHooks.afterMutation;
		try {
			for (const operation of [
				{
					tool: "write",
					params: { path: "a.ts", content: "const value = 1;\n" },
					progress: "writing", complete: "written", content: "const value = 1;\n",
				},
				{
					tool: "edit",
					params: { path: "a.ts", edits: [{ old: "value = 1", new: "value = 2" }] },
					progress: "editing", complete: "applied", content: "const value = 2;\n", replacements: 1,
				},
			] as const) {
				if (operation.tool === "edit") await executeTool(registered, "read", { path: "a.ts" }, ctx);
				const mutation = "replacements" in operation ? { replacements: operation.replacements } : {};
				let release: (() => void) | undefined;
				const gate = new Promise<void>((resolve) => { release = resolve; });
				let contentAtDiagnostics: string | undefined;
				lspFileHooks.afterMutation = async () => {
					contentAtDiagnostics = await readFile(join(cwd, "a.ts"), "utf8");
					await gate;
					return cleanDiagnostics;
				};
				const updates: ExecuteResult[] = [];
				const pending = executeTool(registered, operation.tool, operation.params, ctx, undefined, (update) => updates.push(update));
				await vi.waitFor(() => {
					expect(updates).toEqual(expect.arrayContaining([
						expect.objectContaining({ details: expect.objectContaining({
							status: operation.progress,
							...mutation,
							diff: expect.stringContaining(`+1 ${operation.content.trim()}`),
						}) }),
						expect.objectContaining({ details: expect.objectContaining({
							status: "post-processing",
							...mutation,
							lsp: { status: "running", errors: 0, warnings: 0 },
						}) }),
					]));
					expect(contentAtDiagnostics).toBe(operation.content);
				});
				release?.();
				await expect(pending).resolves.toMatchObject({
					details: { status: operation.complete, lsp: { diagnostics: { status: "clean" } } },
				});
				expect(updates).toEqual(expect.arrayContaining([
					expect.objectContaining({ details: expect.objectContaining({
						status: "post-processing",
						lsp: { status: "clean", errors: 0, warnings: 0 },
					}) }),
				]));
			}

			const failedUpdates: ExecuteResult[] = [];
			await expect(executeTool(registered, "write", { path: ".", content: "invalid" }, ctx, undefined, (update) => failedUpdates.push(update)))
				.resolves.toMatchObject({ details: { status: "failed" } });
			expect(failedUpdates).toEqual([]);
		} finally {
			lspFileHooks.afterMutation = originalAfterMutation;
			await Promise.resolve(handlers.get("session_shutdown")?.({}, {}));
		}
	});
});
