import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createCanvas } from "@napi-rs/canvas";
import { startModelServer } from "../cli/model-server.ts";
import { exerciseModels } from "./model-steps.ts";
import { exerciseMainAppearance } from "./appearance-steps.ts";
import { exerciseModelSelects } from "./select-steps.ts";
import { exerciseHistory, prepareHistory } from "./session-steps.ts";
import { exerciseSessionHeading } from "./session-heading-steps.ts";
import { exerciseReports } from "./report-steps.ts";
import { exercisePanels, exerciseTree } from "./panel-steps.ts";
import { exerciseDeletion } from "./deletion-steps.ts";
import { exerciseWorkspaceRemoval } from "./workspace-steps.ts";
import { exerciseLiveTranscript, exerciseToolDetails } from "./transcript-steps.ts";
import { prepareRichTools } from "./rich-tools-server.ts";
import { exerciseRichTools } from "./rich-tools-steps.ts";
import { exerciseContextUsage, exerciseComposerRunning, exerciseSuggestions, expectComposerLayout } from "./composer-steps.ts";
import { exerciseSuggestionRefresh } from "./suggestion-keyboard-steps.ts";

const root = process.cwd();
let directory: string;
let cwd: string;
let env: Record<string, string>;
let model: Awaited<ReturnType<typeof startModelServer>>;
let history: Awaited<ReturnType<typeof prepareHistory>>;
let richTools: Awaited<ReturnType<typeof prepareRichTools>>;

test.beforeEach(async () => {
	directory = await mkdtemp(path.join(os.tmpdir(), "opi-gui-browser-"));
	cwd = path.join(directory, "workspace");
	const agentDir = path.join(directory, ".pi", "agent");
	await mkdir(path.join(agentDir, "configs"), { recursive: true });
	await mkdir(cwd, { recursive: true });
	await mkdir(path.join(agentDir, "extensions"), { recursive: true });
	await writeFile(
		path.join(agentDir, "extensions", "gui-note.ts"),
		`
import { Type } from "typebox";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
export default function (pi) {
  pi.registerTool({ name: "echo", label: "Echo", description: "Return supplied text", parameters: Type.Object({ text: Type.String() }), async execute(_id, params) { return { content: [{ type: "text", text: params.text }], details: {} }; } });
  pi.registerCommand("gui-note", { description: "Record a local note", getArgumentCompletions: (prefix) => ["todo", "done"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })), async handler(_args, ctx) { const note = await ctx.ui.input("备注"); if (note) ctx.ui.notify(note + " (" + getAgentDir() + ")"); } });
}
`,
	);
	await writeFile(path.join(cwd, "input.ts"), "export function hello() { return 'GUI fixture'; }\n");
	await writeFile(path.join(cwd, "image.png"), createCanvas(32, 32).toBuffer("image/png"));
	richTools = await prepareRichTools(agentDir);
	model = await startModelServer((request) => {
		const rich = richTools.respond(request);
		if (rich) return rich;
		if (JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content)?.includes("只回复下一轮"))
			return { text: `第二轮独立回复\n\n${Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 项检查结果：确认界面在长消息下仍可正常定位与滚动。`).join("\n\n")}` };
		if (JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content)?.includes("验证停止输出"))
			return request.messages.at(-1)?.role === "tool"
				? { text: "停止验证已结束" }
				: { tool: "bash", args: { command: "printf 'composer-ready\\n'; sleep 30" } };
		const count = request.messages.filter((message) => message.role === "tool").length;
		if (count === 0) return { text: "我先检查图片和源码。", thinking: "先检查图片和源码，再验证修改与命令输出。", tool: "read", args: { path: "image.png" } };
		if (count === 1) return { tool: "grep", args: { query: "hello", path: ["input.ts"] } };
		if (count === 2) return { tool: "write", args: { path: "output.txt", content: "GUI bundled tools OK\n" } };
		if (count === 3) return { tool: "read", args: { path: "input.ts", lines: "1" } };
		if (count === 4) return { text: "文件已定位，接下来验证修改和命令输出。", tool: "edit", args: { path: "input.ts", edits: [{ old: "GUI fixture", new: "GUI updated" }] } };
		if (count === 5) return { tool: "bash", args: { command: "printf 'GUI stream started\\n'; printf 'line %s\\n' {1..40}; sleep 2; printf 'GUI stream update\\n'; sleep 2; printf 'GUI shell complete\\n'" } };
		if (count === 6) return { tool: "echo", args: { text: "扩展工具输出" } };
		return { text: "GUI 验证完成：图片、代码搜索和文件写入。" };
	});
	await writeFile(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProjectTrust: "never",
			defaultProvider: "gui-test",
			defaultModel: "test",
			enabledModels: ["gui-test/second", "gui-test/test"],
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	);
	await writeFile(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"gui-test": {
					api: "openai-completions",
					baseUrl: model.url,
					apiKey: "private-test-token",
					models: [
						{ id: "test", name: "GUI Test Model" },
						{ id: "second", name: "GUI Second Model" },
						{ id: "third", name: "GUI Third Model" },
					].map((model) => ({
						...model,
						reasoning: model.id === "test",
						input: ["text", "image"],
						contextWindow: 128000,
						maxTokens: 4096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					})),
				},
			},
		}),
	);
	await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
	env = {
		...Object.fromEntries(
			Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
		),
		HOME: directory,
		USERPROFILE: directory,
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
	};
	delete env.PI_OPI_RESOURCE_DIR;
	delete env.PI_PACKAGE_DIR;
	delete env.ELECTRON_RUN_AS_NODE;
	history = await prepareHistory(directory, cwd);
});
test.afterEach(async () => {
	await model.close();
	await richTools.close();
	await rm(directory, { recursive: true, force: true });
});

async function exerciseLayout(page: Page, screenshotName: string) {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	await expect(page.getByRole("combobox", { name: "模型", exact: true })).toContainText("GUI Test Model");
	await page.getByRole("button", { name: "了解项目" }).click();
	await expect(editor).toHaveValue("梳理这个项目的结构，介绍主要模块和运行方式。");
	await expect(editor).toBeFocused();
	await expect(page.locator(".message.user")).toHaveCount(0);
	await editor.fill("");
	await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
	await page.keyboard.press("Tab");
	await expect(page.getByRole("button", { name: "附件", exact: true })).toBeFocused();
	await expect(page.getByRole("tooltip", { name: "附件", exact: true })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("tooltip", { name: "附件", exact: true })).toHaveCount(0);
	const fileChooser = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "附件", exact: true }).click();
	await (await fileChooser).setFiles(path.join(cwd, "image.png"));
	await expect(page.getByAltText("待发送图片")).toBeVisible();
	await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
	await page.getByRole("button", { name: "移除附件 1", exact: true }).click();
	await expect(page.getByAltText("待发送图片")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "排队方式" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "压缩上下文", exact: true })).toHaveCount(0);
	await expectComposerLayout(page);
	await exerciseModelSelects(page, screenshotName);
	await exerciseSuggestions(page);
	await exerciseSuggestionRefresh(page);
	await editor.fill("/");
	await page.screenshot({ animations: "disabled", path: path.join(root, "dist", `gui-suggestions-${screenshotName}.png`) });
	await editor.fill("");
	await exerciseContextUsage(page);

	const phone = (page.viewportSize()?.width ?? 1200) < 768;
	if (phone) {
		await page.getByRole("button", { name: "菜单", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "工作空间导航", exact: true })).toBeVisible();
		await page.screenshot({
			animations: "disabled",
			path: path.join(root, "dist", `gui-sidebar-${screenshotName}.png`),
		});
		await page.keyboard.press("Escape");
		await expect(page.getByRole("button", { name: "菜单", exact: true })).toBeFocused();
		await page.getByRole("button", { name: "菜单", exact: true }).click();
	} else {
		await page.getByRole("button", { name: "收起侧栏" }).click();
		await expect(page.getByRole("button", { name: "展开侧栏" })).toBeVisible();
		await page.screenshot({
			animations: "disabled",
			path: path.join(root, "dist", `gui-sidebar-${screenshotName}.png`),
		});
	}
	await page.getByRole("button", { name: "设置", exact: true }).click();
	const settings = page.getByRole("dialog", { name: "设置", exact: true });
	await expect(settings).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: path.join(root, "dist", `gui-settings-${screenshotName}.png`),
	});
	await settings.getByRole("button", { name: "关闭面板" }).focus();
	await page.keyboard.press("Shift+Tab");
	expect(await settings.evaluate((element) => element.contains(document.activeElement))).toBe(true);
	const compaction = settings.getByRole("checkbox", { name: "自动压缩", exact: true });
	await expect(compaction).not.toBeChecked();
	await compaction.click();
	await expect(compaction).toBeChecked();
	await compaction.click();
	await expect(compaction).not.toBeChecked();
	await settings.getByRole("button", { name: "编辑完整 settings.json" }).click();
	const config = page.getByRole("dialog", { name: "settings.json", exact: true });
	await expect(config.getByRole("textbox", { name: "设置 JSON" })).toBeVisible();
	await config.getByRole("textbox", { name: "设置 JSON" }).click();
	await page.keyboard.press("Escape");
	await expect(config).toHaveCount(0);
	await expect.poll(() => settings.evaluate((element) => element.contains(document.activeElement))).toBe(true);
	await page.keyboard.press("Escape");
	await expect(settings).toHaveCount(0);
	await expect(editor).toBeFocused();
	await exercisePanels(page, screenshotName);
	if (!phone) await page.getByRole("button", { name: "展开侧栏" }).click();
	await exerciseMainAppearance(page, screenshotName);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function exercise(page: Page, exportedPath?: string) {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await expect(page.getByRole("combobox", { name: "模型", exact: true })).toContainText("GUI Test Model");
	expect((await page.locator(".notices .error").allTextContents()).map((text) => text.slice(0, 1000))).toEqual([]);
	await page.getByRole("button", { name: "展开会话信息", exact: true }).click();
	const info = page.getByRole("complementary", { name: "会话信息", exact: true });
	await info.getByRole("tab", { name: "会话统计", exact: true }).click();
	const turns = info.locator(".report-metric").filter({ has: page.getByText("用户轮次", { exact: true }) }).locator("dd");
	await expect(turns).toHaveText("0");
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("验证真实工具");
	await page.keyboard.press("ControlOrMeta+Enter");
	await exerciseLiveTranscript(page);
	await expect(page.getByRole("main").getByText("GUI 验证完成：图片、代码搜索和文件写入。", { exact: true })).toBeVisible();
	await expect(turns).toHaveText("1");
	await expect(info.getByRole("meter", { name: "read", exact: true })).toBeVisible();
	await info.getByRole("tab", { name: "遥测", exact: true }).click();
	await expect(info.getByRole("meter", { name: "read", exact: true })).toBeVisible();
	await info.getByRole("tab", { name: "会话树", exact: true }).click();
	await expect(info.getByText("验证真实工具", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "收起会话信息", exact: true }).click();
	await exerciseToolDetails(page);
	expect(await readFile(path.join(cwd, "output.txt"), "utf8")).toBe("GUI bundled tools OK\n");
	await expect(page.getByText("执行失败", { exact: true })).toHaveCount(0);
	await exerciseReports(page);
	await exerciseTree(page);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("/gui-note");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await page.getByRole("dialog", { name: "备注" }).getByLabel("输入内容").fill("标准交互验证");
	await page.getByRole("dialog", { name: "备注" }).getByRole("button", { name: "提交", exact: true }).click();
	await expect(page.getByText(/标准交互验证 \(/)).toBeAttached();
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
	await page.getByRole("button", { name: "输入历史", exact: true }).click();
	await page.getByRole("menuitem", { name: "/gui-note", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("/gui-note");
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
	const downloadEvent = exportedPath ? undefined : page.waitForEvent("download");
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("/export");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	if (downloadEvent) expect((await downloadEvent).suggestedFilename()).toMatch(/\.html$/);
	else if (exportedPath) {
		await expect(page.getByText(`已导出: ${exportedPath}`, { exact: true })).toBeAttached();
		const data = await page.evaluate(
			(html) => new DOMParser().parseFromString(html, "text/html").getElementById("session-data")?.textContent,
			await readFile(exportedPath, "utf8"),
		);
		expect(Buffer.from(data ?? "", "base64").toString("utf8")).toContain("GUI 验证完成");
	}
	await exerciseRichTools(page);
	await exerciseComposerRunning(page, path.join(cwd, "image.png"));
	expect(errors).toEqual([]);
}

test("独立 opi-web：真实工具、刷新恢复与响应式布局", async ({ viewport }, info) => {
	const binary = path.join(root, "dist", process.platform === "win32" ? "opi-web.exe" : "opi-web");
	const child = spawn(binary, ["--cwd", cwd, "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	try {
		await expect
			.poll(() => output.match(/opi-web: (http:\/\/[^\s]+)/)?.[1], { message: "opi-web did not start" })
			.toBeTruthy();
		const url = output.match(/opi-web: (http:\/\/[^\s]+)/)?.[1];
		if (!url) throw new Error(output);
		const app = await electron.launch({
			args: [path.join(root, "tests/gui/web-browser.cjs"), "--no-sandbox"],
			cwd,
			env,
			acceptDownloads: true,
		});
		try {
			const page = await app.firstWindow();
			if (viewport) await page.setViewportSize(viewport);
			await page.goto(url);
			await exerciseModels(page, path.join(directory, ".pi", "agent", "settings.json"), info.project.name);
			await exerciseLayout(page, info.project.name);
			await page.screenshot({
				animations: "disabled",
				path: path.join(root, "dist", `gui-welcome-${info.project.name}.png`),
			});
			await exercise(page);
			await exerciseHistory(page, history, info.project.name);
			await exerciseDeletion(page, history, info.project.name);
			await exerciseWorkspaceRemoval(page, history);
			await page.reload();
			await expect(page.getByRole("main").getByText("GUI 验证完成：图片、代码搜索和文件写入。", { exact: true })).toBeVisible();
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await page.screenshot({
				animations: "disabled",
				path: path.join(root, "dist", `gui-${info.project.name}.png`),
				fullPage: true,
			});
			await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
			await page.screenshot({
				animations: "disabled",
				path: path.join(root, "dist", `gui-dark-${info.project.name}.png`),
			});
			for (const size of [
				{ width: 320, height: 568 },
				{ width: 640, height: 360 },
				{ width: 820, height: 900 },
			]) {
				await page.setViewportSize(size);
				if (size.width === 820)
					await expect(page.getByRole("dialog", { name: "工作空间导航", exact: true })).toHaveCount(0);
				await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeInViewport();
				await expect(page.getByRole("button", { name: "发送", exact: true })).toBeInViewport();
				await expectComposerLayout(page);
				await exerciseSuggestions(page);
				await exerciseSessionHeading(page);
				await exerciseContextUsage(page);
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
				if (size.width === 640) {
					await page.getByRole("button", { name: "菜单", exact: true }).click();
					await expect(page.getByRole("dialog", { name: "工作空间导航", exact: true })).toBeVisible();
				}
			}
		} finally {
			await app.close();
		}
	} finally {
		await terminate(child);
	}
});

test("Electron：隔离渲染进程直接使用本地 SDK", async ({ viewport }, info) => {
	test.skip(info.project.name !== "desktop", "桌面应用使用桌面窗口");
	const standalone = path.join(directory, "desktop-app");
	await cp(path.join(root, "dist/desktop/app"), standalone, { recursive: true });
	const app = await electron.launch({ args: [standalone, "--no-sandbox"], cwd, env });
	try {
		const page = await app.firstWindow();
		if (viewport) await page.setViewportSize(viewport);
		const exportedPath = path.join(directory, "export.html");
		await app.evaluate(({ dialog }, filePath) => {
			dialog.showSaveDialog = async () => ({ canceled: false, filePath });
		}, exportedPath);
		await exerciseModels(page, path.join(directory, ".pi", "agent", "settings.json"), "electron");
		await exerciseLayout(page, "electron");
		await exercise(page, exportedPath);
		await exerciseHistory(page, history, "electron");
		await app.evaluate(({ dialog }, directory) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
		}, path.join(path.dirname(cwd), "delete-project"));
		await exerciseDeletion(page, history, "electron");
		await exerciseWorkspaceRemoval(page, history);
		expect(await page.evaluate(() => typeof (globalThis as Record<string, unknown>)["require"])).toBe("undefined");
		await page.screenshot({ animations: "disabled", path: path.join(root, "dist/gui-electron.png") });
	} finally {
		await app.close();
	}
});

async function terminate(child: ChildProcess) {
	if (child.exitCode !== null) return;
	await new Promise<void>((resolve) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolve();
		});
		child.kill("SIGTERM");
	});
}
