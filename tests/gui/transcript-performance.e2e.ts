import { test, expect, type Page, type CDPSession } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { startModelServer } from "../cli/model-server.ts";
import { assistant } from "./transcript-fixtures.ts";

declare global {
	interface Window { transcriptPerf: { tasks: number[]; frames: number[]; started: number } }
}

async function frames(page: Page) {
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function metrics(cdp: CDPSession) {
	const result: { metrics: { name: string; value: number }[] } = await cdp.send("Performance.getMetrics");
	return Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
}
async function measure(page: Page, cdp: CDPSession, action: () => Promise<void>) {
	await page.evaluate(() => { window.transcriptPerf.tasks = []; window.transcriptPerf.frames = []; window.transcriptPerf.started = performance.now(); });
	const before = await metrics(cdp);
	await action();
	await frames(page);
	const result = await page.evaluate(() => ({
		elapsed: performance.now() - window.transcriptPerf.started,
		tasks: window.transcriptPerf.tasks, frames: window.transcriptPerf.frames,
		nodes: document.querySelectorAll("*").length,
		chatRows: document.querySelectorAll(".transcript .message.user, .transcript .assistant-reply").length,
		treeRows: document.querySelectorAll(".session-tree .tree-row").length,
	}));
	const after = await metrics(cdp);
	return { ...result, scriptMs: ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000,
		taskMs: ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000 };
}

for (const turns of [20, 100, 300]) test(`${turns} 轮历史的打开、输入、流式输出及消息定位`, async ({ browser }, info) => {
	const home = await mkdtemp(path.join(os.tmpdir(), "opi-chat-perf-"));
	const cwd = path.join(home, "workspace");
	const agentDir = path.join(home, ".pi", "agent");
	const chunks = Array.from({ length: 60 }, (_, index) => `流式-${String(index).padStart(3, "0")} `);
	let detailed = false;
	const server = await startModelServer((request) => detailed
		? request.messages.some((message) => message.role === "tool") ? { text: "详细任务结束" }
			: { tool: "read", args: { path: "detail.txt" }, text: "处理过程\n\n" + "说明一项检查结果，保持完整过程可读。\n\n".repeat(80) }
		: { text: chunks.join(""), chunks, intervalMs: 20 });
	const context = await browser.newContext(info.project.use.viewport === undefined ? {} : { viewport: info.project.use.viewport });
	let child: ChildProcess | undefined;
	let output = "";
	const measurements: unknown[] = [];
	try {
		await mkdir(cwd, { recursive: true });
		await writeFile(path.join(cwd, "detail.txt"), "用于验证工具过程与定位");
		await mkdir(path.join(agentDir, "configs"), { recursive: true });
		await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", defaultProvider: "gui-test", defaultModel: "test", enabledModels: ["gui-test/test"], compaction: { enabled: false }, retry: { enabled: false } }));
		await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "gui-test": { baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
		await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
		await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
		const sessions = Array.from({ length: 3 }, (_, repetition) => {
			const manager = SessionManager.create(cwd, path.join(agentDir, "sessions", "fixture"));
			const name = `性能-${turns}-${repetition}`;
			manager.appendSessionInfo(name);
			for (let index = 0; index < turns; index++) {
				manager.appendMessage({ role: "user", content: `问题-${index}`, timestamp: index * 2 + 1 });
				manager.appendMessage({ ...assistant([{ type: "text", text: `### 回复-${index}\n\n检查组件边界和运行状态，保留中文内容。\n\n- 第一项说明\n- 第二项说明\n\n\`\`\`ts\nconst answer = ${index};\nconsole.log(answer);\n\`\`\`\n` }], "stop"), timestamp: index * 2 + 2, provider: "gui-test", model: "test" });
			}
			return { name, manager };
		});
		const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/.test(entry[0])));
		Object.assign(env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NODE_ENV: "test" });
		child = spawn(process.env.OPI_GUI_TEST_BINARY ?? path.resolve("dist/web", process.platform === "win32" ? "opi-web.exe" : "opi-web"), ["--cwd", cwd, "--host", "127.0.0.1", "--port", "0"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		let url = "";
		await expect.poll(() => { url = output.match(/opi-web: (http:\/\/[^\s]+)/)?.[1] ?? ""; return url; }).toBeTruthy();
		const page = await context.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.addInitScript(() => {
			window.transcriptPerf = { tasks: [], frames: [], started: 0 };
			new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (entry.startTime >= window.transcriptPerf.started) window.transcriptPerf.tasks.push(entry.duration); }).observe({ type: "longtask" });
			document.addEventListener("input", (event) => {
				if (!(event.target instanceof HTMLTextAreaElement) || event.target.getAttribute("aria-label") !== "消息") return;
				const start = performance.now();
				requestAnimationFrame(() => requestAnimationFrame(() => window.transcriptPerf.frames.push(performance.now() - start)));
			});
		});
		await page.goto(url);
		const cdp = await context.newCDPSession(page);
		await cdp.send("Performance.enable");
		const phone = info.project.name === "phone";
		const navigation = page.locator(phone ? ".mobile-sidebar" : ".sidebar");
		const menu = async () => { if (phone && !await page.locator('.mobile-sidebar[data-state="open"]').count()) await page.getByRole("button", { name: "菜单", exact: true }).click(); };
		for (const { name } of sessions) {
			await menu();
			const history = navigation.getByRole("button", { name, exact: true });
			await expect(history).toBeVisible();
			measurements.push({ phase: "open", ...await measure(page, cdp, async () => {
				await history.click();
				await expect(page.locator(".session-heading")).toContainText(name);
				await expect(page.getByRole("heading", { name: `回复-${turns - 1}`, exact: true })).toBeVisible();
				await expect(page.getByRole("list", { name: "会话消息树" }).getByRole("button", { name: /^定位消息/ }).first()).toBeVisible();
			}) });
			const editor = page.getByRole("textbox", { name: "消息", exact: true });
			measurements.push({ phase: "input", ...await measure(page, cdp, () => editor.pressSequentially("performance typing sample", { delay: 20 })) });
			measurements.push({ phase: "stream", ...await measure(page, cdp, async () => {
				await page.getByRole("button", { name: "发送", exact: true }).click();
				await expect(page.locator('.assistant-reply[data-state="completed"]').filter({ hasText: "流式-059" })).toBeVisible();
			}) });
		}
		if (turns > 50) {
			expect(await page.locator(".transcript .assistant-reply").count()).toBeLessThan(50);
			expect(await page.locator(".session-tree .tree-row").count()).toBeLessThan(80);
		}
		// 从消息树跳到未挂载的历史，再返回最新内容。
		await page.locator('.session-tab-body[data-active="true"]').evaluate((element) => { element.scrollTop = 0; });
		const tree = page.getByRole("list", { name: "会话消息树" });
		await tree.getByRole("button", { name: /^定位消息/ }).filter({ hasText: "问题-0" }).click();
		await expect(page.locator(".message.user").filter({ hasText: "问题-0" })).toBeInViewport();
		await page.getByRole("button", { name: "回到最新", exact: true }).click();
		await expect(page.locator('.assistant-reply[data-state="completed"]').filter({ hasText: "流式-059" })).toBeInViewport();
		if (turns === 300) {
			detailed = true;
			const editor = page.getByRole("textbox", { name: "消息", exact: true });
			await editor.fill("生成详细检查过程");
			await page.getByRole("button", { name: "发送", exact: true }).click();
			const reply = page.locator('.assistant-reply[data-state="completed"]').filter({ hasText: "详细任务结束" });
			await expect(reply).toBeVisible();
			const process = reply.locator(':scope > .reply-process');
			await process.locator(':scope > .disclosure-trigger').click();
			await expect(process).toHaveAttribute("data-state", "open");
			await editor.focus();
			await page.locator(".transcript").evaluate((element) => { element.scrollTop = 0; });
			await expect(reply).not.toBeAttached();
			await page.locator('.session-tab-body[data-active="true"]').evaluate((element) => { element.scrollTop = element.scrollHeight; });
			await tree.getByRole("button", { name: /^定位消息/ }).filter({ hasText: "详细任务结束" }).click();
			await expect(reply.locator(".reply-answer")).toBeInViewport();
			await expect(process).toHaveAttribute("data-state", "open");
			const reader = page.locator(".transcript");
			await reader.evaluate((element) => { element.scrollTop -= 900; });
			await frames(page);
			const top = await reader.evaluate((element) => element.scrollTop);
			await menu();
			await navigation.getByRole("button", { name: `性能-${turns}-0`, exact: true }).click();
			await expect(page.locator(".session-heading")).toContainText(`性能-${turns}-0`);
			await menu();
			await navigation.getByRole("button", { name: `性能-${turns}-2`, exact: true }).click();
			await expect(process).toHaveAttribute("data-state", "open");
			await expect.poll(async () => Math.abs(await reader.evaluate((element) => element.scrollTop) - top)).toBeLessThan(3);
			// 文本选区不能因移出虚拟窗口而丢失。
			await editor.focus();
			await reader.evaluate((element) => {
				const body = element.querySelector(".reply-turn-content .reply-body article");
				if (!body) throw new Error("缺少过程正文");
				const range = document.createRange(); range.selectNodeContents(body);
				const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
			});
			const selected = await page.evaluate(() => document.getSelection()?.toString());
			await frames(page);
			await reader.evaluate((element) => { element.scrollTop = 0; });
			await frames(page);
			expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(selected);
			await page.evaluate(() => document.getSelection()?.removeAllRanges());
		}
		expect(errors).toEqual([]);
	} finally {
		await info.attach("measurements", { body: JSON.stringify({ turns, viewport: info.project.use.viewport, measurements }, null, 2), contentType: "application/json" });
		await context.close();
		if (child?.exitCode === null) await new Promise<void>((resolve) => { const timer = setTimeout(() => child?.kill("SIGKILL"), 10000); child?.once("exit", () => { clearTimeout(timer); resolve(); }); child?.kill("SIGTERM"); });
		await server.close();
		await rm(home, { recursive: true, force: true });
	}
});
