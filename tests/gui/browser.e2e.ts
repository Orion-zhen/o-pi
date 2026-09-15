import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createCanvas } from "@napi-rs/canvas";
import { startModelServer } from "../cli/model-server.ts";

const root = process.cwd();
let directory: string;
let cwd: string;
let env: Record<string, string>;
let model: Awaited<ReturnType<typeof startModelServer>>;

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
  pi.registerCommand("gui-note", { description: "Record a local note", async handler(_args, ctx) { const note = await ctx.ui.input("备注"); if (note) ctx.ui.notify(note + " (" + getAgentDir() + ")"); } });
}
`,
	);
	await writeFile(path.join(cwd, "input.ts"), "export function hello() { return 'GUI fixture'; }\n");
	await writeFile(path.join(cwd, "image.png"), createCanvas(32, 32).toBuffer("image/png"));
	model = await startModelServer((request) => {
		const count = request.messages.filter((message) => message.role === "tool").length;
		if (count === 0) return { tool: "read", args: { path: "image.png" } };
		if (count === 1) return { tool: "grep", args: { query: "hello", path: ["input.ts"] } };
		if (count === 2) return { tool: "write", args: { path: "output.txt", content: "GUI bundled tools OK\n" } };
		return { text: "GUI 验证完成：图片、代码搜索和文件写入。" };
	});
	await writeFile(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProjectTrust: "never",
			defaultProvider: "gui-test",
			defaultModel: "test",
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
						{
							id: "test",
							name: "GUI Test Model",
							reasoning: false,
							input: ["text", "image"],
							contextWindow: 128000,
							maxTokens: 4096,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
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
});
test.afterEach(async () => {
	await model.close();
	await rm(directory, { recursive: true, force: true });
});

async function exercise(page: Page, exportedPath?: string) {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await expect(page.getByRole("combobox", { name: "模型", exact: true })).toContainText("GUI Test Model");
	expect((await page.locator(".notices .error").allTextContents()).map((text) => text.slice(0, 1000))).toEqual([]);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("验证真实工具");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByText("GUI 验证完成：图片、代码搜索和文件写入。", { exact: true })).toBeVisible();
	expect(await readFile(path.join(cwd, "output.txt"), "utf8")).toBe("GUI bundled tools OK\n");
	await expect(page.getByText("执行失败", { exact: true })).toHaveCount(0);
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("/stats");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "会话统计", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "关闭面板" }).click();
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("/gui-note");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await page.getByRole("dialog", { name: "备注" }).getByLabel("输入内容").fill("标准交互验证");
	await page.getByRole("dialog", { name: "备注" }).getByRole("button", { name: "提交", exact: true }).click();
	await expect(page.getByText(/标准交互验证 \(/)).toBeAttached();
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
			await exercise(page);
			await page.reload();
			await expect(page.getByText("GUI 验证完成：图片、代码搜索和文件写入。", { exact: true })).toBeVisible();
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await page.screenshot({ path: path.join(root, "dist", `gui-${info.project.name}.png`), fullPage: true });
		} finally {
			await app.close();
		}
	} finally {
		await terminate(child);
	}
});

test("Electron：隔离渲染进程直接使用本地 SDK", async ({}, info) => {
	test.skip(info.project.name !== "desktop", "桌面应用使用桌面窗口");
	const standalone = path.join(directory, "desktop-app");
	await cp(path.join(root, "dist/desktop/app"), standalone, { recursive: true });
	const app = await electron.launch({ args: [standalone, "--no-sandbox"], cwd, env });
	try {
		const page = await app.firstWindow();
		const exportedPath = path.join(directory, "export.html");
		await app.evaluate(({ dialog }, filePath) => {
			dialog.showSaveDialog = async () => ({ canceled: false, filePath });
		}, exportedPath);
		await exercise(page, exportedPath);
		expect(await page.evaluate(() => typeof (globalThis as Record<string, unknown>)["require"])).toBe("undefined");
		await page.screenshot({ path: path.join(root, "dist/gui-electron.png") });
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
