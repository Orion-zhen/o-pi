import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Page } from "@playwright/test";
import { test as base, expect } from "./fixture.ts";
import { startModelServer } from "../cli/model-server.ts";

const test = base.extend<{ webPage: Page }>({
	webPage: async ({ workspace: { cwd, env }, page }, use) => {
		const binary = process.env.OPI_GUI_TEST_BINARY ?? path.resolve("dist/web", process.platform === "win32" ? "opi-web.exe" : "opi-web");
		const child = spawn(binary, ["--cwd", cwd, "--host", "127.0.0.1", "--port", "0"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		try {
			let url = "";
			await expect.poll(() => { url = output.match(/opi-web: (http:\/\/[^\s]+)/)?.[1] ?? ""; return url; }).toBeTruthy();
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.goto(url);
			await use(page);
			expect(errors).toEqual([]);
		} finally {
			if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => {
				const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
				child.once("exit", () => { clearTimeout(timer); resolve(); });
				child.kill("SIGTERM");
			});
		}
	},
});

let model: Awaited<ReturnType<typeof startModelServer>>;
test.beforeEach(async ({ workspace: { agentDir } }) => {
	for (const [name, body] of [
		["gui-manual", "# 手动技能\n\n先检查任务范围。"],
		["gui-model", "# 模型技能\n\n" + "长正文用于验证按需加载。".repeat(6_000) + "正文结束标记"],
	] as const) {
		const directory = path.join(agentDir, "skills", name);
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: 技能可视化验证\ndisable-model-invocation: false\n---\n${body}\n`);
	}
	model = await startModelServer((request) => {
		const user = request.messages.findLastIndex((message) => message.role === "user");
		return request.messages.slice(user + 1).some((message) => message.role === "tool")
			? { text: "技能验证完成" } : { tool: "skill", args: { name: "gui-model" }, text: "先加载任务所需技能。" };
	});
	await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProjectTrust: "never", defaultProvider: "gui-test", defaultModel: "test", compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "gui-test": {
		api: "openai-completions", baseUrl: model.url, apiKey: "fixture", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
});
test.afterEach(async () => { await model?.close(); });

test("完成一轮后手动加载技能，刷新和下一轮都不改变卡片位置", async ({ webPage: page }) => {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const send = async (text: string) => { await editor.fill(text); await editor.press("ControlOrMeta+Enter"); };
	const order = () => page.locator(".transcript-row > .message.user, .transcript-row > .assistant-reply, .transcript-row > .skill-message")
		.evaluateAll((elements) => elements.map((element) => element.matches(".skill-message") ? "skill" : element.matches(".assistant-reply") ? "reply" : "user"));
	await send("完成第一轮任务");
	await expect(page.locator(".assistant-reply")).toHaveAttribute("data-state", "completed");
	await send("/skill:gui-manual");
	await expect(page.locator(".transcript-row > .skill-message")).toContainText("gui-manual");
	await expect.poll(order).toEqual(["user", "reply", "skill"]);
	await expect(page.locator(".assistant-reply .skill-message")).toHaveCount(0);
	await send("开始下一轮任务");
	await expect(page.locator(".reply-answer")).toContainText(["技能验证完成", "技能验证完成"]);
	await expect.poll(order).toEqual(["user", "reply", "skill", "user", "reply"]);
	await expect(page.locator(".assistant-reply .skill-activity")).toHaveCount(2);
	await page.reload();
	await expect.poll(order).toEqual(["user", "reply", "skill", "user", "reply"]);
	await expect(page.locator(".assistant-reply .skill-message")).toHaveCount(0);
});

test("技能卡片、按需正文、会话树与按需查询", async ({ webPage: page }, info) => {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const send = async (text: string) => { await editor.fill(text); await editor.press("ControlOrMeta+Enter"); };
	await send("/skill:gui-manual");
	const manual = page.locator(".skill-message .skill-activity").first();
	await expect(manual.locator(".activity-summary")).toContainText("手动引用");
	await expect(manual.locator(".activity-state > svg")).toBeVisible();
	await expect(manual.locator(".activity-state")).toHaveText("");
	await expect(manual.locator(".skill-body")).toHaveCount(0);
	expect(model.requests.filter((request) => Array.isArray(request.messages))).toHaveLength(0);
	await manual.locator(".activity-summary").click();
	await expect(manual.getByRole("heading", { name: "手动技能" })).toBeVisible();
	await expect(manual.locator(".skill-metadata")).toContainText("skill://gui-manual");
	await manual.locator(".activity-summary").click();
	await send("/skill:gui-manual");
	await expect(page.locator(".skill-message .activity-summary").last()).toContainText("已加载过");
	expect(model.requests.filter((request) => Array.isArray(request.messages))).toHaveLength(0);

	await send("验证模型主动加载技能");
	await expect(page.locator(".reply-answer")).toContainText("技能验证完成");
	const process = page.locator(".assistant-reply > .reply-process");
	await expect(process).toHaveAttribute("data-state", "closed");
	await expect(process.locator(":scope > .disclosure-trigger")).toContainText("技能 gui-model");
	await process.locator(":scope > .disclosure-trigger").click();
	const activity = process.locator(".reply-activity");
	await expect(activity.locator(":scope > .disclosure-trigger")).toContainText("技能 gui-model");
	await activity.locator(":scope > .disclosure-trigger").click();
	const skill = activity.locator(".skill-activity");
	await expect(skill.locator(".activity-summary")).toContainText("模型调用");
	await expect(skill.locator(".activity-state svg")).toBeVisible();
	await expect(skill.locator(".skill-body")).toHaveCount(0);
	await skill.locator(".activity-summary").click();
	await expect(skill.getByRole("heading", { name: "模型技能" })).toBeVisible();
	await expect(skill.locator(".skill-body")).toContainText("正文结束标记");
	await expect(skill.locator(".tool-raw pre")).toHaveCount(0);
	await skill.locator(".activity-summary").click();

	if (!await page.locator('.session-sidebar[data-open="true"]').count()) await page.getByRole("button", { name: "展开会话信息", exact: true }).click();
	const sidebar = page.getByRole("complementary", { name: "会话信息", exact: true });
	await expect(sidebar).not.toContainText("本分支已加载");
	const skillRows = page.locator(".tree-row").filter({ has: page.locator(".tree-role", { hasText: /^技能$/ }) });
	await expect(skillRows.locator(".tree-message-preview")).toHaveText(["gui-manual · 手动引用", "gui-manual · 已加载过，未重复注入"]);
	await expect(skillRows.locator(".tree-role svg")).toHaveCount(2);
	await expect(skillRows).not.toContainText(["invoked_skill", "invoked_skill"]);
	await page.screenshot({ path: info.outputPath("skills.png"), animations: "disabled" });
	await page.reload();
	await expect(page.locator(".reply-answer")).toContainText("技能验证完成");
	await expect(process.locator(":scope > .disclosure-trigger")).toContainText("技能 gui-model");
	if (!await page.locator('.session-sidebar[data-open="true"]').count()) await page.getByRole("button", { name: "展开会话信息", exact: true }).click();
	await expect(sidebar).not.toContainText("本分支已加载");
	await expect(skillRows.locator(".tree-message-preview")).toHaveText(["gui-manual · 手动引用", "gui-manual · 已加载过，未重复注入"]);
	const entryId = await page.locator(".skill-message").first().getAttribute("data-entry-id");
	if (!entryId) throw new Error("缺少技能消息定位 ID");
	await skillRows.first().getByRole("button", { name: `定位消息 ${entryId}`, exact: true }).click();
	await expect(page.locator(".skill-message").first()).toBeInViewport();
	const requests = model.requests.filter((request) => Array.isArray(request.messages)).length;
	await send("/skill");
	await expect(page.locator(".notices")).toContainText("Disclosed skills:");
	await expect(page.locator(".notices")).toContainText("gui-manual");
	await expect(page.locator(".notices")).toContainText("gui-model");
	expect(model.requests.filter((request) => Array.isArray(request.messages))).toHaveLength(requests);
});
