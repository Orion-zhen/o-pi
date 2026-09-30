import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import fileTools from "../../../src/harness/extensions/file-tools.ts";
import { lspManager } from "../../../src/harness/lsp/index.ts";
import { registerExtension } from "../../helpers/extension.ts";
import { useTempDir } from "../../helpers/lifecycle.ts";
import { executeTool } from "../file-tools/extension-fixture.ts";

const workspace = useTempDir("opi-file-batch-");
afterEach(() => vi.restoreAllMocks());

it.each([false, true])("文件修改在并发或顺序执行时都能完成，诊断对应各自文件：%s", async (parallel) => {
	const { registered, handlers } = registerExtension(fileTools);
	const cwd = workspace.path;
	const ctx = { cwd, sessionManager: { getSessionId: () => "batch", getBranch: () => [] } };
	const diagnostics = (message: string) => ({
		status: "errors" as const, file_errors: 1, file_warnings: 0, new_errors: 1, new_warnings: 0,
		resolved_errors: 0, resolved_warnings: 0, baseline: "unknown" as const, total_items: 1,
		items: [{ severity: "error" as const, line: 1, column: 1, message }],
	});
	vi.spyOn(lspManager, "afterMutation").mockImplementation(async (input) => diagnostics(basename(input.filePath)));
	vi.spyOn(lspManager, "afterMutationBatch").mockImplementation(async (inputs) => {
		for (const input of inputs) expect(await readFile(input.filePath, "utf8")).toBe("updated\n");
		return inputs.map((input) => diagnostics(basename(input.filePath)));
	});
	const calls = [{ id: "a", name: "write" }, { id: "b", name: "edit" }];
	try {
		await writeFile(join(cwd, "b.ts"), "before\n");
		await executeTool(registered, "read", { path: "b.ts" }, ctx);
		await handlers.get("message_end")?.({ message: {
			role: "assistant", content: calls.map((call) => ({ type: "toolCall", ...call, arguments: {} })),
		} });
		const write = registered.find((tool) => tool.name === "write");
		const edit = registered.find((tool) => tool.name === "edit");
		if (!write || !edit) throw new Error("文件工具未注册");
		const runWrite = () => write.execute("a", { path: "a.ts", content: "updated\n" }, undefined, undefined, ctx);
		const runEdit = () => edit.execute("b", { path: "b.ts", edits: [{ old: "before", new: "updated" }] }, undefined, undefined, ctx);
		await handlers.get("tool_execution_start")?.({ toolCallId: "a" });
		const a = runWrite();
		if (!parallel) await a;
		await handlers.get("tool_execution_start")?.({ toolCallId: "b" });
		const results = await Promise.all([a, runEdit()]);
		for (const [index, result] of results.entries()) {
			const file = index === 0 ? "a.ts" : "b.ts";
			expect(result.details).toMatchObject({ path: file, lsp: { diagnostics: { items: [{ message: file }] } } });
			expect(await readFile(join(cwd, file), "utf8")).toBe("updated\n");
		}
	} finally { await handlers.get("session_shutdown")?.({}, ctx); }
});
