import { test, expect, type Locator, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startModelServer, type ModelResponse } from "../cli/model-server.ts";
import { deferred } from "../helpers/async.ts";
import { storeSession } from "./session-fixture.ts";
import { expectActivityTrail } from "./activity-border-assertions.ts";

test.use({ actionTimeout: 15_000 });

/** Web 使用真实 Chromium，桌面 IPC 仍由原 Electron 套件覆盖。 */
test("会话边框、工作区圆点、审批归属、未读删除保护和草稿保持", async ({ browser }, info) => {
	const home = await mkdtemp(path.join(os.tmpdir(), "opi-multi-browser-"));
	// 项目目录不能位于系统临时目录，否则写入会获得临时范围审批豁免。
	const projects = await mkdtemp(path.join(process.cwd(), ".gui-test-multi-"));
	const root = path.join(projects, "root");
	const cwd = path.join(projects, "project-a");
	const other = path.join(projects, "project-b");
	const agentDir = path.join(home, ".pi", "agent");
	const bashCommand = `printf '%s\\n' '${"中文 <script>不是网页脚本</script> ".repeat(30)}' > output.txt`;
	const startup = deferred<ModelResponse>();
	const startupEntered = deferred<void>();
	const startupServer = await startModelServer(() => { startupEntered.resolve(); return startup.promise; });
	const first = deferred<ModelResponse>();
	const parallel = deferred<ModelResponse>();
	const last = deferred<ModelResponse>();
	const model = await startModelServer((request) => {
		if (!Array.isArray(request.messages)) return { text: "" };
		if (JSON.stringify(request.messages).includes("并行任务")) return parallel.promise;
		return request.messages.some((message) => message.role === "tool") ? last.promise : first.promise;
	});
	let child: ChildProcess | undefined;
	let output = "";
	const errors: string[] = [];
	const context = await browser.newContext({ viewport: info.project.use.viewport ?? { width: 1200, height: 820 } });
	try {
		await mkdir(root, { recursive: true });
		await mkdir(path.join(agentDir, "configs"), { recursive: true });
		await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
			defaultProjectTrust: "never", defaultProvider: "gui-test", defaultModel: "test", enabledModels: ["gui-test/test"],
			compaction: { enabled: false }, retry: { enabled: false },
		}));
		await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
			"gui-test": { baseUrl: model.url, api: "openai-completions", apiKey: "fixture", models: [{
				id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}] },
		} }));
		await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
		await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
		await writeFile(path.join(agentDir, "configs", "approval-gate.jsonc"), '{"tools":{"bash":{"default_action":"ask"},"write":{"default_action":"ask"}}}');
		await storeSession({ cwd, agentDir, provider: "gui-test", name: "项目 A 历史" });
		await mkdir(path.join(cwd, "src"));
		await writeFile(path.join(cwd, "src", "reading.ts"), "export const text = '保持文件阅读位置';\n".repeat(100));
		await mkdir(path.join(agentDir, "extensions"));
		await writeFile(path.join(agentDir, "extensions", "startup.ts"),
			`export default function(pi) { pi.on('session_start', async (_event, ctx) => { if (ctx.sessionManager.getSessionName() === '项目 A 历史') await fetch(${JSON.stringify(startupServer.url)}, { method: 'POST', body: '{"messages":[]}' }); }); }`);
		await storeSession({ cwd: other, agentDir, provider: "gui-test", name: "项目 B 历史" });
		const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined
			&& /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/.test(entry[0])));
		Object.assign(env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NODE_ENV: "test" });
		child = spawn(process.env.OPI_GUI_TEST_BINARY ?? path.resolve("dist/web", process.platform === "win32" ? "opi-web.exe" : "opi-web"), ["--cwd", root, "--host", "127.0.0.1", "--port", "0"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		let url = "";
		await expect.poll(() => { url = output.match(/opi-web: (http:\/\/[^\s]+)/)?.[1] ?? ""; return url; }).toBeTruthy();
		const page = await context.newPage();
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(url);
		const phone = info.project.name === "phone";
		const navigation = (target: Page) => target.locator(phone ? ".mobile-sidebar" : ".sidebar");
		const menu = async (target: Page) => { if (phone && !await target.locator('.mobile-sidebar[data-state="open"]').count()) await target.getByRole("button", { name: "菜单", exact: true }).click(); };
		const closeMenu = async () => { if (phone && await page.locator('.mobile-sidebar[data-state="open"]').count()) await page.getByRole("button", { name: "关闭菜单", exact: true }).click(); };
		const picker = async (target: Page) => { await menu(target); await navigation(target).getByRole("combobox", { name: "工作区", exact: true }).click(); };
		const switchTo = async (target: Page, directory: string) => {
			await picker(target);
			await target.getByRole("option", { name: directory, exact: true }).click();
			await expect(target.locator(".workspace-select").first()).toContainText(path.basename(directory));
			await expect(target.locator('textarea[aria-label="消息"]')).toBeVisible();
		};
		const rename = async (name: string) => {
			await page.locator(".session-heading button").click();
			await page.getByRole("textbox", { name: "会话名称", exact: true }).fill(name);
			await page.getByRole("textbox", { name: "会话名称", exact: true }).press("Enter");
		};
		const row = (title: string) => navigation(page).locator(".history-session-row").filter({ has: page.getByRole("button", { name: title, exact: true }) });
		const workspaceButton = navigation(page).getByRole("combobox", { name: "工作区", exact: true });
		const solidShield = async (marker: Locator) => {
			await expect(marker).toBeVisible();
			await expect.poll(() => marker.locator("path").first().evaluate((element) => {
				const style = getComputedStyle(element);
				return style.fill !== "none" && style.fill === style.color;
			})).toBe(true);
		};
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await expect(editor).toBeVisible();
		await switchTo(page, cwd);
		await menu(page);
		if (phone) await navigation(page).locator(".workbench-pane-tabs").getByRole("button", { name: "文件", exact: true }).click();
		const tree = navigation(page).getByRole("tree", { name: "工作区文件", exact: true, includeHidden: true });
		await tree.getByRole("treeitem", { name: "src", exact: true }).click();
		await tree.getByRole("treeitem", { name: "src/reading.ts", exact: true }).click();
		const filePreview = page.locator(".file-preview");
		await expect(filePreview.locator(".file-preview-body")).toContainText("保持文件阅读位置");
		await filePreview.getByRole("button", { name: "自动折行", exact: true }).click();
		await filePreview.locator(".file-preview-body").evaluate((element) => { element.scrollTop = 100; });
		const body = await filePreview.locator(".file-preview-body").elementHandle();
		if (!body) throw new Error("缺少文件阅读视图");
		await menu(page);
		if (phone) await navigation(page).locator(".workbench-pane-tabs").getByRole("button", { name: "会话", exact: true }).click();
		const search = navigation(page).getByRole("textbox", { name: "搜索会话", exact: true });
		await search.fill("项目 A");
		const globalReads: string[] = [];
		page.on("request", (request) => {
			if (!request.url().match(/\/api\/(query|action)$/)) return;
			const body: { value: { query?: string; action?: string } } = request.postDataJSON();
			if (body.value.query === "guiConfig" || body.value.action === "sessions") globalReads.push(request.url());
		});
		await row("项目 A 历史").getByRole("button", { name: "项目 A 历史", exact: true }).click();
		await startupEntered.promise;
		await expect(page.locator(".composer")).toHaveCount(0);
		await expect(filePreview).toHaveAttribute("data-wrap", "false");
		expect(await body.evaluate((element) => element.isConnected && element.scrollTop === 100)).toBe(true);
		await menu(page);
		await expect(search).toHaveValue("项目 A");
		await expect(tree.getByRole("treeitem", { name: "src", exact: true, includeHidden: true })).toHaveAttribute("aria-expanded", "true");
		expect(globalReads).toEqual([]);
		startup.resolve({ text: "ready" });
		// 手机抽屉仍打开，此时编辑器已挂载但不在模态框的可访问区域内。
		await expect(page.locator('.composer textarea[aria-label="消息"]')).toBeAttached();
		await search.fill("");
		await row("新会话").getByRole("button", { name: "新会话", exact: true }).click();
		await expect(editor).toBeVisible();
		expect(globalReads).toEqual([]);
		await closeMenu();
		await filePreview.getByRole("button", { name: "关闭文件预览", exact: true }).click();
		await rename("任务 A");
		await editor.fill("后台任务");
		await editor.press("Control+Enter");
		await expect.poll(() => model.requests.filter((request) => Array.isArray(request.messages)).length).toBe(1);
		await editor.fill("A 的草稿");
		await page.locator('.composer input[type="file"]').setInputFiles({
			name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ZkAAAAASUVORK5CYII=", "base64"),
		});
		await expect(page.locator(".image-previews img")).toHaveCount(1);
		await menu(page);
		await navigation(page).getByRole("button", { name: "新建会话", exact: true }).click();
		await rename("任务 A2");
		await editor.fill("并行任务");
		await editor.press("Control+Enter");
		await expect.poll(() => model.requests.filter((request) => Array.isArray(request.messages)).length).toBe(2);
		await expect(page.locator(".message.user")).toContainText("并行任务");
		await menu(page);
		for (const title of ["任务 A", "任务 A2"]) {
			await expect(row(title).locator('.activity-border[data-activity="running"]')).toHaveCount(1);
			await expect(row(title).getByRole("button", { name: `删除会话 ${title}`, exact: true })).toHaveCount(0);
		}
		await expect(workspaceButton).toHaveAttribute("data-attention", "false");
		await expectActivityTrail(row("任务 A").locator(".activity-border"));
		await navigation(page).screenshot({ path: info.outputPath("sessions-running.png") });
		await page.emulateMedia({ reducedMotion: "reduce" });
		await expect(row("任务 A").locator(".activity-border")).toHaveCSS("animation-name", "none");
		await page.emulateMedia({ reducedMotion: "no-preference" });
		await switchTo(page, other);
		await expect(page.locator(".image-previews img")).toHaveCount(0);
		await editor.fill("B 的草稿");
		await picker(page);
		const aRow = page.getByRole("option", { name: cwd, exact: true }).locator("..");
		await expect(aRow.locator('.workspace-option-status[data-activity="running"]')).toHaveCount(1);
		await expect(workspaceButton.locator(".approval-marker")).toHaveCount(0);
		await expect(aRow.locator(".activity-border")).toHaveCount(0);
		await expect(aRow.getByRole("button", { name: `移除工作区 ${cwd}`, exact: true })).toHaveCount(0);
		await expect(workspaceButton).toHaveAttribute("data-attention", "true");
		await page.emulateMedia({ reducedMotion: "reduce" });
		await expect.poll(() => aRow.locator(".workspace-option-status").evaluate((element) => getComputedStyle(element, "::before").animationName)).toBe("none");
		await page.keyboard.press("Escape");
		await closeMenu();
		for (let index = 0; index < 3; index++) {
			await switchTo(page, cwd);
			await expect(page.locator(".message.user")).toContainText("并行任务");
			await switchTo(page, other);
		}
		await page.emulateMedia({ reducedMotion: "no-preference" });
		first.resolve({ tool: "bash", args: { command: bashCommand } });
		await picker(page);
		// A2 仍在运行，A 的审批必须优先透传到工作区和选择按钮。
		await solidShield(workspaceButton.locator(".approval-marker"));
		await expect(workspaceButton.locator(".approval-marker + .lucide-chevrons-up-down")).toHaveCount(1);
		await solidShield(aRow.locator(".approval-marker"));
		await expect(aRow.locator(".workspace-option-status")).toHaveCount(0);
		await expect(aRow.getByRole("button", { name: `移除工作区 ${cwd}`, exact: true })).toHaveCount(0);
		await page.screenshot({ path: info.outputPath("workspace-approval.png"), animations: "disabled" });
		await page.keyboard.press("Escape");
		if (!phone) {
			await navigation(page).getByRole("button", { name: "收起侧栏", exact: true }).click();
			await solidShield(workspaceButton.locator(".approval-marker"));
			await expect(workspaceButton.locator(".lucide-folder-open")).toHaveCount(0);
			await navigation(page).getByRole("button", { name: "展开侧栏", exact: true }).click();
		}
		parallel.resolve({ text: "并行任务完成" });
		const approval = page.getByRole("dialog").filter({ has: page.getByText("请选择", { exact: true }) });
		await expect(approval).toHaveCount(0);
		await closeMenu();
		await switchTo(page, cwd);
		await expect(page.locator(".reply-answer")).toContainText("并行任务完成");
		await expect(approval).toHaveCount(0);
		await menu(page);
		await expect(workspaceButton.locator(".approval-marker")).toHaveCount(0);
		await solidShield(row("任务 A").locator(".approval-marker"));
		await expect(row("任务 A").getByRole("button", { name: "删除会话 任务 A", exact: true })).toHaveCount(0);
		await row("任务 A").getByRole("button", { name: "任务 A", exact: true }).click();
		await expect(approval).toBeVisible();
		await expect(approval.getByRole("button", { name: "取消 / 拒绝", exact: true })).toHaveCount(0);
		await expect(approval.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
		const command = approval.getByRole("group", { name: "Bash 命令", exact: true });
		await expect(command.getByRole("button", { name: "展开完整命令", exact: true })).toHaveAttribute("aria-expanded", "false");
		await expect(command.locator(".approval-command-preview pre code")).toHaveText([...bashCommand].slice(0, 240).join(""));
		await expect(command.locator('.token.string').filter({ hasText: "中文" })).toBeVisible();
		await expect(approval.locator(".approval-target")).toContainText("output.txt");
		await expect(approval.locator(".approval-sensitive .token:is(.function, .builtin)").first()).toHaveCSS("color",
			await approval.locator(".approval-target").evaluate((element) => getComputedStyle(element).color));
		await expect(approval.locator("script")).toHaveCount(0);
		await expect(readFile(path.join(cwd, "output.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		await page.screenshot({ path: info.outputPath("bash-approval-collapsed.png"), animations: "disabled" });
		await command.getByRole("button", { name: "展开完整命令", exact: true }).click();
		await expect(command.getByRole("button", { name: "收起命令", exact: true })).toHaveAttribute("aria-expanded", "true");
		await expect(command.locator('[data-slot="collapsible-content"] pre code')).toHaveText(bashCommand);
		await expect(readFile(path.join(cwd, "output.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		await command.getByRole("button", { name: "收起命令", exact: true }).focus();
		await page.keyboard.press("Enter");
		await expect(command.getByRole("button", { name: "展开完整命令", exact: true })).toHaveAttribute("aria-expanded", "false");
		await page.emulateMedia({ reducedMotion: "reduce" });
		await command.getByRole("button", { name: "展开完整命令", exact: true }).click();
		await expect(command.locator('[data-slot="collapsible-content"] pre code')).toBeVisible();
		await page.screenshot({ path: info.outputPath("bash-approval-expanded.png"), animations: "disabled" });
		await page.emulateMedia({ reducedMotion: "no-preference" });
		await approval.getByRole("button", { name: "Allow once", exact: true }).click();
		await expect.poll(() => readFile(path.join(cwd, "output.txt"), "utf8").catch((error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
			throw error;
		})).toContain("中文 <script>");
		await expect(editor).toHaveValue("A 的草稿");
		await menu(page);
		await row("任务 A2").getByRole("button", { name: "任务 A2", exact: true }).click();
		await switchTo(page, other);
		await expect(editor).toHaveValue("B 的草稿");
		await picker(page);
		await expect(workspaceButton.locator(".approval-marker")).toHaveCount(0);
		await expect(aRow.locator(".approval-marker")).toHaveCount(0);
		await expect(aRow.locator('.workspace-option-status[data-activity="running"]')).toHaveCount(1);
		await page.keyboard.press("Escape");
		await closeMenu();
		last.resolve({ text: `后台任务完成\n\n${"结果说明，用于验证切换后的阅读位置。\n\n".repeat(35)}` });
		await picker(page);
		await expect(aRow.locator('.workspace-option-status[data-activity="unread"]')).toHaveCount(1);
		await expect(aRow.getByRole("button", { name: `移除工作区 ${cwd}`, exact: true })).toHaveCount(0);
		await page.screenshot({ path: info.outputPath("workspace-unread.png"), animations: "disabled" });
		await page.getByRole("option", { name: cwd, exact: true }).click();
		await expect(page.locator(".session-heading")).toContainText("任务 A2");
		await menu(page);
		const unreadBorder = row("任务 A").locator('.activity-border[data-activity="unread"]');
		await expect(unreadBorder).toHaveCount(1);
		await expect(unreadBorder).toHaveCSS("animation-play-state", "paused");
		await expect.poll(() => unreadBorder.locator("rect").last().evaluate((element) =>
			getComputedStyle(element).strokeDasharray.split(/[\s,]+/).map((value) => parseFloat(value)))).toEqual([0, 0, 100, 0]);
		await expect(row("任务 A").getByRole("button", { name: "删除会话 任务 A", exact: true })).toHaveCount(0);
		await expect(row("任务 A2").getByRole("button", { name: "删除会话 任务 A2", exact: true })).toHaveCount(1);
		await navigation(page).screenshot({ path: info.outputPath("session-unread.png") });
		await picker(page);
		await expect(aRow.locator('.workspace-option-status[data-activity="unread"]')).toHaveCount(1);
		await expect(aRow.getByRole("option")).toHaveAttribute("aria-selected", "true");
		await page.keyboard.press("Escape");
		await row("任务 A").getByRole("button", { name: "任务 A", exact: true }).click();
		await expect(page.locator(".reply-answer")).toContainText("后台任务完成");
		await expect(editor).toHaveValue("A 的草稿");
		await menu(page);
		await expect(row("任务 A").locator('.activity-border[data-activity="idle"]')).toHaveCount(1);
		await expect(row("任务 A").getByRole("button", { name: "删除会话 任务 A", exact: true })).toHaveCount(1);
		await row("任务 A2").hover();
		await row("任务 A2").getByRole("button", { name: "删除会话 任务 A2", exact: true }).click({ modifiers: ["Control"] });
		await expect(row("任务 A2")).toHaveCount(0);
		await picker(page);
		await expect(aRow.locator(".workspace-option-status")).toHaveCount(0);
		await expect(aRow.locator(".lucide-check")).toHaveCount(1);
		await page.keyboard.press("Escape");
		await closeMenu();

		await expect(page.locator(".image-previews img")).toHaveCount(1);
		await page.locator(".reply-activity > .disclosure-trigger").click();
		await page.locator(".tool-activity .activity-summary").click();
		await expect(page.locator(".tool-activity .activity-summary")).toHaveAttribute("aria-expanded", "true");
		await page.locator(".transcript").evaluate((element) => { element.scrollTop = 0; });
		await expect(page.getByRole("button", { name: "回到最新", exact: true })).toBeVisible();
		await switchTo(page, other);
		await switchTo(page, cwd);
		await expect(page.locator(".tool-activity .activity-summary")).toHaveAttribute("aria-expanded", "true");
		await expect.poll(() => page.locator(".transcript").evaluate((element) => element.scrollTop)).toBe(0);
		await expect(page.locator(".image-previews img")).toHaveCount(1);

		const second = await context.newPage();
		await second.goto(url);
		await switchTo(second, other);
		await expect(page.locator(".session-heading")).toContainText("任务 A");
		await expect(editor).toHaveValue("A 的草稿");
		await switchTo(page, other);
		await picker(page);
		await aRow.hover();
		await aRow.getByRole("button", { name: `移除工作区 ${cwd}`, exact: true }).click();
		await aRow.getByRole("button", { name: `确认移除工作区 ${cwd}`, exact: true }).click();
		await expect(aRow).toHaveCount(0);
		expect(errors).toEqual([]);
	} catch (error) {
		await info.attach("backend", { body: output, contentType: "text/plain" });
		const page = context.pages()[0];
		if (page) await info.attach("failure", { body: await page.screenshot({ path: info.outputPath("failure.png") }), contentType: "image/png" });
		throw error;
	} finally {
		startup.resolve({ text: "cancelled" });
		first.resolve({ text: "cancelled" }); parallel.resolve({ text: "cancelled" }); last.resolve({ text: "cancelled" });
		await context.close();
		if (child && child.exitCode === null) {
			const process = child;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => process.kill("SIGKILL"), 10_000);
				process.once("exit", () => { clearTimeout(timer); resolve(); });
				process.kill("SIGTERM");
			});
		}
		await model.close();
		await startupServer.close();
		await rm(home, { recursive: true, force: true });
		await rm(projects, { recursive: true, force: true });
	}
});
