import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixture.ts";
import { startModelServer } from "../cli/model-server.ts";

for (const mode of ["web", "desktop"] as const) test.describe(`路由模型 ${mode}`, () => {
	test.use({ mode });
	let model: Awaited<ReturnType<typeof startModelServer>>;
	test.beforeEach(async ({ workspace: { cwd, agentDir } }, info) => {
		test.skip(mode === "desktop" && info.project.name !== "desktop", "桌面入口只验证一次");
		model = await startModelServer((request) => request.messages.some((message) => message.role === "tool")
			? { text: "路由验证完成" } : { tool: "read", args: { path: "input.txt" } });
		await writeFile(path.join(cwd, "input.txt"), "routing fixture\n");
		await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
		await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
			defaultProjectTrust: "never", defaultProvider: "router", defaultModel: "auto",
			enabledModels: ["router/auto", "fixture/fast", "fixture/precise"],
			compaction: { enabled: false }, retry: { enabled: false },
		}));
		await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
			api: "openai-completions", baseUrl: model.url, apiKey: "fixture",
			models: ["fast", "precise"].map((id) => ({ id, name: id, reasoning: false, input: ["text"],
				contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
		} } }));
		await mkdir(path.join(agentDir, "extensions"));
		await writeFile(path.join(agentDir, "extensions", "router.ts"), `export default (pi) => pi.registerVirtualModel({
			provider: "router", id: "auto", name: "Auto",
			route: (request, ctx) => ({ model: ctx.modelRegistry.find("fixture", request.reason === "user" ? "fast" : "precise"), thinkingLevel: "off" }),
		});`);
	});
	test.afterEach(async () => { await model?.close(); });

	test("保留所选模型，显示实际响应，刷新后恢复且窄屏不越界", async ({ gui: { page } }) => {
		const selected = page.getByRole("combobox", { name: "模型", exact: true });
		await expect(selected).toHaveText("Auto");
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("读取 input.txt");
		await editor.press("ControlOrMeta+Enter");
		await expect(page.locator(".reply-answer")).toContainText("路由验证完成");
		expect(model.requests.map((request) => request.model)).toEqual(["fast", "precise"]);
		for (let view = 0; view < 2; view++) {
			await expect(selected).toHaveText("Auto");
			await expect(page.getByLabel("最近响应模型", { exact: true })).toContainText("precise · off");
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
			if (view === 0) await page.reload();
		}
		await selected.click();
		await page.getByRole("option", { name: "fast", exact: true }).click();
		await expect(page.getByLabel("最近响应模型", { exact: true })).toHaveCount(0);
	});
});
