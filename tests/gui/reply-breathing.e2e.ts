import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixture.ts";
import { startModelServer, type ModelRequest, type ModelResponse } from "../cli/model-server.ts";

let model: Awaited<ReturnType<typeof startModelServer>>;
let respond: (request: ModelRequest) => Promise<ModelResponse>;

test.beforeEach(async ({ workspace: { agentDir, cwd } }) => {
	model = await startModelServer((request) => respond(request));
	await writeFile(path.join(cwd, "example.txt"), "等待下一轮输出");
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", defaultProvider: "breathing-test", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "breathing-test": {
		api: "openai-completions", baseUrl: model.url, apiKey: "fixture",
		models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
});
test.afterEach(async () => { await model?.close(); });

for (const text of ["", "先检查文件。"])
	test(`等待模型及工具后续回复时持续变形，完成后退出（${text ? "含中途正文" : "仅工具"}）`, async ({ gui: { page } }) => {
		const tool = Promise.withResolvers<ModelResponse>();
		const answer = Promise.withResolvers<ModelResponse>();
		respond = (request) => request.messages.some((message) => message.role === "tool") ? answer.promise : tool.promise;
		await page.getByRole("textbox", { name: "消息", exact: true }).fill("读取 example.txt 后总结");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		const indicator = page.getByRole("status", { name: "正在处理", exact: true });
		await expect(indicator).toBeVisible();
		const original = await indicator.elementHandle();
		if (!original) throw new Error("缺少活动标记");
		const shape = indicator.locator("path");
		const initial = await shape.getAttribute("d");
		await expect.poll(() => shape.getAttribute("d")).not.toBe(initial);
		tool.resolve({ tool: "read", args: { path: "example.txt" }, text });
		await expect(page.locator('.tool-activity[data-state="completed"]')).toBeVisible();
		await expect.poll(() => model.requests.some((request) => request.messages?.some((message) => message.role === "tool"))).toBe(true);
		if (text) {
			await page.locator('.assistant-reply > .reply-process > .disclosure-trigger').click();
			await expect(page.locator('.assistant-reply > .reply-process')).toHaveAttribute("data-state", "closed");
		}
		await expect(indicator).toBeVisible();
		expect(await original.evaluate((element) => element.isConnected)).toBe(true);
		const afterTool = await shape.getAttribute("d");
		await expect.poll(() => shape.getAttribute("d")).not.toBe(afterTool);
		answer.resolve({ text: "读取完成" });
		await expect(page.locator('.assistant-reply[data-state="completed"]')).toContainText("读取完成");
		await expect(indicator).toHaveCount(0);
	});

test("流式正文期间显示活动标记，正文完成后移除", async ({ gui: { page } }) => {
	const chunks = ["检查结果：\n\n", ...Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 项检查完成。\n\n`)];
	respond = async () => ({ text: chunks.join(""), chunks, intervalMs: 100 });
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("逐项汇报检查结果");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator('.assistant-reply[data-state="running"] .reply-answer')).toContainText("第 1 项检查完成。");
	const indicator = page.getByRole("status", { name: "正在处理", exact: true });
	await expect(indicator).toBeVisible();
	await expect(page.locator('.assistant-reply[data-state="completed"] .reply-answer')).toContainText("第 20 项检查完成。");
	await expect(indicator).toHaveCount(0);
});

test("停止请求后移除活动标记", async ({ gui: { page } }) => {
	const answer = Promise.withResolvers<ModelResponse>();
	respond = () => answer.promise;
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("稍等再回答");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	const indicator = page.getByRole("status", { name: "正在处理", exact: true });
	await expect(indicator).toBeVisible();
	await page.getByRole("button", { name: "停止", exact: true }).click();
	await expect(indicator).toHaveCount(0);
	await expect(page.locator('.assistant-reply[data-state="stopped"]')).toContainText("已停止");
	answer.resolve({ text: "已取消" });
});
