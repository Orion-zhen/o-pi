import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import fileTools from "../../agent/extensions/file-tools.js";
import { lspFileOperations as lspFileHooks } from "../../src/lsp/index.js";
import { executeTool, type ExecuteResult, type ExecuteTool, type LifecycleHandler } from "./extension-fixture.js";

describe("file-tools extension mutation progress", () => {
	it("edit/write 在提交前报告实时 diff，并在文件落盘后进入验证阶段", async () => {
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
				return undefined;
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
			await vi.waitFor(() => expect(writeUpdates).toHaveLength(2));
			expect(writeUpdates).toEqual([
				expect.objectContaining({ details: expect.objectContaining({ status: "writing", diff: expect.stringContaining("+1 const value = 1;") }) }),
				expect.objectContaining({ details: expect.objectContaining({ status: "verifying", diff: expect.stringContaining("+1 const value = 1;") }) }),
			]);
			expect(writeAtDiagnostics).toBe("const value = 1;\n");
			releaseWrite?.();
			await expect(pendingWrite).resolves.toMatchObject({ details: { status: "written" } });

			await executeTool(registered, "read", { path: "a.ts" }, ctx);
			let releaseEdit: (() => void) | undefined;
			const editGate = new Promise<void>((resolve) => { releaseEdit = resolve; });
			let editAtDiagnostics: string | undefined;
			lspFileHooks.afterWrite = async () => {
				editAtDiagnostics = await readFile(join(cwd, "a.ts"), "utf8");
				await editGate;
				return undefined;
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
			await vi.waitFor(() => expect(editUpdates).toHaveLength(2));
			expect(editUpdates).toEqual([
				expect.objectContaining({ details: expect.objectContaining({ status: "editing", replacements: 1, diff: expect.stringContaining("+1 const value = 2;") }) }),
				expect.objectContaining({ details: expect.objectContaining({ status: "verifying", replacements: 1, diff: expect.stringContaining("+1 const value = 2;") }) }),
			]);
			expect(editAtDiagnostics).toBe("const value = 2;\n");
			releaseEdit?.();
			await expect(pendingEdit).resolves.toMatchObject({ details: { status: "applied" } });

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
