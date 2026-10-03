import { test, expect } from "./fixture.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { startModelServer } from "../cli/model-server.ts";
import { createCanvas } from "@napi-rs/canvas";
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
		if (JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content)?.includes("验证长文阅读"))
			return { text: Array.from({ length: 6 }, (_, index) => `### 阅读画布 ${index + 1}\n\n导航和操作浮在内容上方，正文与代码保持清晰。Surface, content and controls.\n\n\`\`\`ts\nconst message = "Hello, 世界";\nconsole.log(message);\n\`\`\``).join("\n\n") };
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

test.describe("浏览器交互", () => {

	test("深浅主题的普通悬停背景统一，选中态与按下态独立", async ({ gui: { page }, workspace: { agentDir } }, info) => {
		test.skip(info.project.name !== "desktop", "鼠标悬停使用桌面视口");
		const attachment = page.getByRole("button", { name: "附件", exact: true });
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		for (const theme of ["light", "dark"] as const) {
			await writeFile(path.join(agentDir, "configs", "gui.jsonc"), JSON.stringify({ theme }));
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
			await expect.poll(async () => {
				await attachment.hover();
				return attachment.evaluate((element) => getComputedStyle(element).backgroundColor);
			}).toMatch(/^rgb\(/);
			const background = await attachment.evaluate((element) => getComputedStyle(element).backgroundColor);
			for (const target of [page.locator(".workspace-select").first(), page.locator(".files-toggle")]) {
				await target.hover();
				await expect(target).toHaveCSS("background-color", background);
			}
			if (theme === "light") {
				const starter = page.locator(".starter").first();
				await starter.hover();
				await expect(starter).toHaveCSS("background-color", background);
				await editor.fill("验证悬停颜色");
				await editor.press("ControlOrMeta+Enter");
				await expect(page.locator(".reply-answer")).toContainText("GUI 验证完成");
				await page.locator(".assistant-reply > .reply-process > .disclosure-trigger").click();
				await page.locator(".reply-activity:has(.activity-summary) > .disclosure-trigger").first().click();
			}
			const activity = page.locator(".activity-summary").first();
			await expect.poll(async () => {
				await activity.hover();
				return activity.evaluate((element) => getComputedStyle(element).backgroundColor);
			}).toBe(background);
			const rename = page.locator(".history-session-row .row-action-button").first();
			await rename.locator("..").locator("..").hover();
			await rename.hover();
			await expect(rename).toHaveCSS("background-color", background);
			const stats = page.getByRole("tab", { name: "会话统计", exact: true });
			await stats.hover();
			await expect(stats).toHaveCSS("background-color", background);
			await stats.click();
			await expect(stats).not.toHaveCSS("background-color", background);
			const report = page.getByRole("tabpanel", { name: "会话统计", exact: true }).locator(".report-section > .disclosure-trigger").first();
			await report.hover();
			await expect(report).toHaveCSS("background-color", background);
			await page.getByRole("tab", { name: "会话树", exact: true }).click();
			await page.getByRole("button", { name: "模型", exact: true }).click();
			const models = page.getByRole("dialog", { name: "模型", exact: true });
			const model = models.locator(".model-row").first();
			await model.hover();
			await expect(model).toHaveCSS("background-color", background);
			await models.getByRole("button", { name: "关闭面板", exact: true }).click();
			await attachment.hover();
			await page.mouse.down();
			await expect(attachment).not.toHaveCSS("background-color", background);
			await page.mouse.move(0, 0);
			await page.mouse.up();
		}
	});

	test("真实工具、扩展交互、导出和刷新恢复", async ({ gui: { page }, workspace: { cwd } }) => {
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
		const download = page.waitForEvent("download");
		await editor.fill("/export");
		await editor.press("ControlOrMeta+Enter");
		await (await download).saveAs(exported);
		expect(await readFile(exported, "utf8")).toContain("session-data");
		const data = await page.evaluate((html) => new DOMParser().parseFromString(html, "text/html").getElementById("session-data")?.textContent, await readFile(exported, "utf8"));
		expect(Buffer.from(data ?? "", "base64").toString("utf8")).toContain("GUI 验证完成");
		expect(await page.evaluate(() => typeof (globalThis as Record<string, unknown>)["require"])).toBe("undefined");
	});

	test("键盘调整侧栏，长文上翻后返回最新消息", async ({ gui: { page } }) => {
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("验证长文阅读");
		await editor.press("ControlOrMeta+Enter");
		await expect(page.locator(".reply-answer")).toContainText("阅读画布 6");
		if ((page.viewportSize()?.width ?? 0) > 1024) {
			for (const [label, selector, key] of [["调整左侧栏宽度", ".sidebar", "ArrowRight"], ["调整右侧栏宽度", ".session-sidebar", "ArrowLeft"]] as const) {
				const panel = page.locator(selector);
				const width = await panel.evaluate((element) => element.getBoundingClientRect().width);
				const handle = page.getByRole("separator", { name: label, exact: true });
				await handle.press(key);
				await expect.poll(() => panel.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(width);
				await expect(editor).toBeVisible();
				await handle.press("Home");
				await expect.poll(() => panel.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(width, 0);
			}
		}
		await page.locator(".transcript").hover();
		await page.mouse.wheel(0, -10000);
		const latest = page.getByRole("button", { name: "回到最新", exact: true });
		await expect(latest).toBeVisible();
		await latest.click();
		await expect(latest).toHaveCount(0);
		await expect.poll(() => page.locator(".transcript").evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(60);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	});

	test("会话图片通过引用按需加载，刷新后仍可显示", async ({ gui: { page } }) => {
		await page.locator('.composer input[type="file"]').setInputFiles({
			name: "pixel.png", mimeType: "image/png", buffer: createCanvas(2, 2).toBuffer("image/png"),
		});
		await expect(page.locator(".image-previews img")).toHaveCount(1);
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("验证图片正文");
		await editor.press("ControlOrMeta+Enter");
		const image = page.locator(".message.user .attachment");
		await expect(page.locator(".reply-answer")).toContainText("GUI 验证完成");
		await image.scrollIntoViewIfNeeded();
		await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2);
		await page.reload();
		await expect(page.locator(".reply-answer")).toContainText("GUI 验证完成");
		await image.scrollIntoViewIfNeeded();
		await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2);
	});

	test("运行时引导、跟进队列和停止", async ({ gui: { page } }) => {
		await exerciseComposerRunning(page);
	});

	test("网页工具与子代理执行、取消", async ({ gui: { page } }) => {
		await exerciseRichTools(page);
	});
});
