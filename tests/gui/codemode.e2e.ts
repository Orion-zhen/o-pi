import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixture.ts";
import { startModelServer } from "../cli/model-server.ts";

for (const mode of ["web", "desktop"] as const) {
	test.describe(`codemode ${mode}`, () => {
		test.use({ mode });
		let model: Awaited<ReturnType<typeof startModelServer>>;
		test.beforeEach(async ({ workspace: { cwd, agentDir } }, info) => {
			test.skip(mode === "desktop" && info.project.name !== "desktop", "桌面入口只需验证一次");
			model = await startModelServer((request) => request.messages?.some((message) => message.role === "tool")
				? { text: "嵌套验证完成" }
				: { tool: "codemode", args: { code: 'const r = await tools.find({query:"sample"}); text(r.matches[0].path);' } });
			await writeFile(path.join(cwd, "sample.ts"), "export const value = 1;\n");
			await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
			await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
				defaultProjectTrust: "never", defaultProvider: "fixture", defaultModel: "test",
				defaultTools: ["+codemode"], compaction: { enabled: false }, retry: { enabled: false },
			}));
			await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
				api: "openai-completions", baseUrl: model.url, apiKey: "fixture",
				models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			} } }));
		});
		test.afterEach(async () => { await model?.close(); });

		test("打包运行并在刷新后展示 SDK 嵌套记录", async ({ gui: { page } }) => {
			const editor = page.getByRole("textbox", { name: "消息", exact: true });
			await editor.fill("查找 sample 文件");
			await editor.press("ControlOrMeta+Enter");
			await expect(page.locator(".reply-answer")).toContainText("嵌套验证完成");
			const toolResult = model.requests.findLast((request) => Array.isArray(request.messages))?.messages.find((message) => message.role === "tool");
			expect(JSON.stringify(toolResult)).toContain("sample.ts");
			expect(JSON.stringify(toolResult)).not.toContain("Script failed");
			await page.reload();
			await expect(page.locator(".reply-answer")).toContainText("嵌套验证完成");
			await page.locator(".assistant-reply .reply-activity > .disclosure-trigger").click();
			const tool = page.locator('[data-tool="codemode"]');
			await tool.locator(".tool-nested > .disclosure-trigger").click();
			await expect(tool.locator("[data-nested-tool-call-id]")).toContainText("find");
			await expect(tool.locator("[data-nested-tool-call-id]")).toContainText("完成");
		});
	});
}
