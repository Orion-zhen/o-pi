import { test, expect } from "./fixture.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { startModelServer } from "../cli/model-server.ts";
import { exerciseModels } from "./model-steps.ts";
import { exerciseComposerRunning, exerciseSuggestions } from "./composer-steps.ts";
import { prepareRichTools } from "./rich-tools-server.ts";
import { exerciseRichTools } from "./rich-tools-steps.ts";

let model: Awaited<ReturnType<typeof startModelServer>>;
let richTools: Awaited<ReturnType<typeof prepareRichTools>>;
test.beforeEach(async ({ workspace: { cwd, agentDir } }) => {
	await writeFile(path.join(cwd, "input.ts"), "export const answer = 42;\n");
	await mkdir(path.join(agentDir, "extensions"));
	await writeFile(path.join(agentDir, "extensions", "gui-note.ts"), `
export default function (pi) {
	pi.registerCommand("gui-note", { description: "Record a note", getArgumentCompletions: () => [{value: "todo", label: "todo"}], async handler(_args, ctx) {
		const note = await ctx.ui.input("备注");
		if (note) ctx.ui.notify(note);
	} });
}
`);
	richTools = await prepareRichTools(agentDir);
	model = await startModelServer((request) => {
		const rich = richTools.respond(request);
		if (rich) return rich;
		if (JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content)?.includes("验证停止输出"))
			return { tool: "bash", args: { command: "printf 'composer-ready\\n'; sleep 30" } };
		const count = request.messages.filter((message) => message.role === "tool").length;
		if (count === 0) return { thinking: "先确认输入文件", text: "我先检查输入文件", tool: "read", args: { path: "input.ts" } };
		if (count === 1) return { thinking: "输入已确认，写入结果", text: "接下来写入验证结果", tool: "write", args: { path: "output.txt", content: "GUI tools OK\n" } };
		return { text: "GUI 验证完成" };
	});
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProjectTrust: "never", defaultProvider: "gui-test", defaultModel: "test",
		enabledModels: ["gui-test/second", "gui-test/test"], compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "gui-test": {
		api: "openai-completions", baseUrl: model.url, apiKey: "private-test-token",
		models: ["test", "second", "third"].map((id) => ({
			id, name: id, reasoning: id === "test", input: ["text", "image"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	} } }));
});
test.afterEach(async () => { await model?.close(); await richTools?.close(); });

for (const mode of ["web", "desktop"] as const) test.describe(mode, () => {
	test.use({ mode });
	test.beforeEach(({}, info) => { test.skip(mode === "desktop" && info.project.name !== "desktop", "桌面应用使用桌面窗口"); });

	test("真实工具、扩展交互、导出和刷新恢复", async ({ gui: { page, app }, workspace: { cwd } }) => {
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await exerciseSuggestions(page);
		await editor.fill("验证真实工具");
		await editor.press("ControlOrMeta+Enter");
		await expect(page.locator(".reply-answer")).toContainText("GUI 验证完成");
		expect(await readFile(path.join(cwd, "output.txt"), "utf8")).toBe("GUI tools OK\n");
		const process = page.locator(".assistant-reply > .reply-process");
		await expect(process).toHaveAttribute("data-state", "closed");
		await process.locator(":scope > .disclosure-trigger").click();
		await expect(page.locator(".reply-turn-content > .reply-body article")).toHaveText(["我先检查输入文件", "接下来写入验证结果"]);
		await expect(page.locator(".reply-turn-content > .reply-body").first()).toBeVisible();
		const activities = page.locator(".reply-activity");
		await expect(activities).toHaveCount(3);
		for (const activity of await activities.all()) await expect(activity).toHaveAttribute("data-state", "closed");
		await activities.first().locator(":scope > .disclosure-trigger").click();
		await expect(activities.first()).toHaveAttribute("data-state", "open");
		await page.reload();
		await expect(page.locator(".reply-answer")).toContainText("GUI 验证完成");
		await expect(process).toHaveAttribute("data-state", "closed");
		await editor.fill("/gui-note");
		await editor.press("ControlOrMeta+Enter");
		const dialog = page.getByRole("dialog", { name: "备注" });
		await dialog.getByLabel("输入内容").fill("标准交互验证");
		await dialog.getByRole("button", { name: "提交", exact: true }).click();
		await expect(page.locator(".notices")).toContainText("标准交互验证");
		await expect(page.locator(".notices .disclosure-trigger")).toHaveAttribute("data-state", "open");
		await page.getByRole("button", { name: "清除通知" }).click();
		await expect(page.locator(".notices")).toHaveCount(0);
		await editor.fill("/gui-note");
		await editor.press("ControlOrMeta+Enter");
		await dialog.getByLabel("输入内容").fill("时间线通知");
		await dialog.getByRole("button", { name: "提交", exact: true }).click();
		await expect(page.locator(".notices")).toContainText("时间线通知");
		await editor.fill("验证时间线");
		await editor.press("ControlOrMeta+Enter");
		await expect(page.locator(".notices .disclosure-trigger")).toHaveAttribute("data-state", "closed");
		const timeline = await page.locator(".transcript-content .message, .transcript-content .assistant-reply, .transcript-content .notices")
			.evaluateAll((els) => els.map((el) => el.matches(".notices") ? "notice" : el.matches(".message.user") ? "user" : "reply"));
		expect(timeline.join(",")).toContain("reply,notice,user");
		const exported = path.join(cwd, "export.html");
		if (mode === "desktop") await app.evaluate(({ dialog }, filePath) => {
			dialog.showSaveDialog = async () => ({ canceled: false, filePath });
		}, exported);
		const download = mode === "web" ? page.waitForEvent("download") : undefined;
		await editor.fill("/export");
		await editor.press("ControlOrMeta+Enter");
		if (download) await (await download).saveAs(exported);
		// expect.poll 不重试谓函数抛出的错误, 文件由主进程异步落盘, 需用 toPass 重试整个读取断言块.
		await expect(async () => expect(await readFile(exported, "utf8")).toContain("session-data")).toPass();
		const data = await page.evaluate((html) => new DOMParser().parseFromString(html, "text/html").getElementById("session-data")?.textContent, await readFile(exported, "utf8"));
		expect(Buffer.from(data ?? "", "base64").toString("utf8")).toContain("GUI 验证完成");
		expect(await page.evaluate(() => typeof (globalThis as Record<string, unknown>)["require"])).toBe("undefined");
	});

	test("模型选择与范围持久化", async ({ gui: { page }, workspace: { agentDir } }) => {
		await exerciseModels(page, path.join(agentDir, "settings.json"));
	});

	test("运行时引导、跟进队列和停止", async ({ gui: { page } }) => {
		await exerciseComposerRunning(page);
	});

	test("网页工具与子代理执行、取消", async ({ gui: { page } }) => {
		await exerciseRichTools(page);
	});
});
