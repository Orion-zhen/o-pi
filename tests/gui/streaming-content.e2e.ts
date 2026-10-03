import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixture.ts";
import { startModelServer } from "../cli/model-server.ts";

let model: Awaited<ReturnType<typeof startModelServer>>;
test.beforeEach(async ({ workspace: { agentDir } }) => {
	model = await startModelServer(() => ({ text: "", chunks: ["```ts\nconst answer = 42;\n```\n\n", ...Array.from({ length: 30 }, (_, index) => `正文-${index} `)], intervalMs: 80 }));
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", defaultProvider: "stream-test", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "stream-test": {
		api: "openai-completions", baseUrl: model.url, apiKey: "fixture",
		models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
});
test.afterEach(async () => { await model?.close(); });

test("流式追加正文和完成高亮不重挂已有代码块", async ({ gui: { page } }) => {
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("输出代码及说明");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	const code = page.locator(".reply-answer .code-block").first();
	await expect(code).toContainText("const answer = 42;");
	const original = await code.elementHandle();
	if (!original) throw new Error("缺少代码块");
	await expect(page.locator('.assistant-reply[data-state="completed"]')).toContainText("正文-29");
	expect(await original.evaluate((element) => element.isConnected)).toBe(true);
	await expect(code.locator(".token").first()).toBeVisible();
	await expect(code.getByRole("button", { name: "复制ts" })).toBeVisible();
});

test("欢迎动效由浏览器播放，交互后回到静止状态", async ({ gui: { page } }) => {
	const logo = page.locator(".welcome-mark .app-logo");
	await page.locator(".welcome h1").click();
	await expect.poll(() => logo.evaluate((element) => element.getAnimations().some((animation) =>
		animation.playState === "running" && animation.effect?.getTiming().duration === 3200)), { timeout: 8000 }).toBe(true);
	await page.locator(".welcome h1").click();
	await expect.poll(() => logo.evaluate((element) => element.getAnimations().length)).toBe(0);
	await expect(logo).toHaveCSS("transform", "none");
});
