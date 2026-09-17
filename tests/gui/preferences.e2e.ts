import { test, expect, _electron as electron, type Page, type Locator } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function drag(page: Page, handle: Locator, x: number, y = 0) {
	const box = await handle.boundingBox();
	if (!box) throw new Error("拖拽把手不可见");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + x, box.y + box.height / 2 + y, { steps: 12 });
	await page.mouse.up();
}

for (const mode of ["web", "desktop"] as const) test(`${mode}：GUI 偏好、系统字体、连续拖拽与双击重置`, async ({ viewport }, info) => {
	const home = await mkdtemp(path.join(os.tmpdir(), "opi-preferences-e2e-"));
	const cwd = path.join(home, "workspace");
	const agentDir = path.join(home, ".pi", "agent");
	const configFile = path.join(agentDir, "configs", "gui.jsonc");
	await mkdir(cwd, { recursive: true });
	await mkdir(path.dirname(configFile), { recursive: true });
	await writeFile(path.join(agentDir, "settings.json"), '{"defaultProjectTrust":"never"}');
	await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
	const env = Object.fromEntries(Object.entries({ ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NODE_ENV: "test", XDG_CONFIG_HOME: path.join(home, "config") }).filter((entry): entry is [string, string] => entry[1] !== undefined));
	delete env.PI_OPI_RESOURCE_DIR;
	delete env.PI_PACKAGE_DIR;
	delete env.PI_GUI_CONFIG;
	delete env.ELECTRON_RUN_AS_NODE;
	let child: ChildProcess | undefined;
	try {
		let url = "";
		if (mode === "web") {
			child = spawn(path.resolve("dist", process.platform === "win32" ? "opi-web.exe" : "opi-web"), ["--cwd", cwd, "--host", "127.0.0.1", "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
			child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
			await expect.poll(() => { url = output.match(/opi-web: (http:\/\/[^\s]+)/)?.[1] ?? ""; return url; }, { message: "偏好测试服务启动" }).toBeTruthy();
		}
		const app = await electron.launch({ args: [path.resolve(mode === "web" ? "tests/gui/web-browser.cjs" : "dist/desktop/app"), "--no-sandbox"], cwd, env });
		try {
			const page = await app.firstWindow();
			if (viewport) await page.setViewportSize(viewport);
			if (mode === "web") await page.goto(url);
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			const phone = info.project.name === "phone";
			const openSettings = async () => {
				if (phone) await page.getByRole("button", { name: "菜单", exact: true }).click();
				await page.getByRole("button", { name: "设置", exact: true }).click();
				await page.getByRole("tab", { name: "GUI", exact: true }).click();
			};
			const settings = page.getByRole("dialog", { name: "设置", exact: true });
			await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
			await openSettings();
			await expect(settings.getByRole("combobox", { name: "主题", exact: true })).toHaveValue("system");
			await settings.getByRole("combobox", { name: "主题", exact: true }).selectOption("dark");
			await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
			await page.emulateMedia({ colorScheme: "light" });
			await expect(page.locator("body")).toHaveCSS("background-color", "rgb(27, 29, 34)");
			await settings.getByRole("button", { name: "重置主题", exact: true }).click();
			await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
			await expect(page.locator("body")).toHaveCSS("background-color", "rgb(248, 249, 251)");
			for (const [label, size] of [["界面字号", "18"], ["对话字号", "22"], ["代码字号", "17"]] as const) {
				const input = settings.getByRole("spinbutton", { name: label, exact: true });
				await input.fill(size);
				await input.press("Enter");
				await expect(input).toBeEnabled();
			}
			await expect(settings.locator(".typography-preview strong")).toHaveCSS("font-size", "18px");
			await expect(settings.locator(".typography-preview p")).toHaveCSS("font-size", "22px");
			await expect(settings.locator(".typography-preview code")).toHaveCSS("font-size", "17px");
			await settings.getByRole("combobox", { name: "界面字体", exact: true }).click();
			await page.getByRole("button", { name: "读取本机字体", exact: true }).click();
			await expect.poll(async () => ({ ready: await page.getByRole("listbox", { name: "界面字体", exact: true }).getByRole("option").count() > 1, error: await page.locator(".font-picker [role=alert]").allTextContents() })).toEqual({ ready: true, error: [] });
			const family = (await page.getByRole("listbox", { name: "界面字体", exact: true }).getByRole("option").nth(1).innerText()).trim();
			await page.getByRole("textbox", { name: "搜索界面字体", exact: true }).fill(family);
			await page.getByRole("option", { name: family, exact: true }).click();
			await expect(settings.getByRole("combobox", { name: "界面字体", exact: true })).toContainText(family);
			await expect.poll(() => page.locator("body").evaluate((element) => getComputedStyle(element).fontFamily)).toContain(family);
			await settings.getByRole("button", { name: "恢复 GUI 默认设置", exact: true }).click();
			await expect(settings.getByRole("spinbutton", { name: "界面字号", exact: true })).toHaveValue("14");
			await settings.getByRole("button", { name: "编辑 gui.jsonc", exact: true }).click();
			const json = page.getByRole("textbox", { name: "GUI 设置 JSONC", exact: true });
			await json.fill('{\n // 保留我的注释\n "theme": "dark"\n}\n');
			await page.getByRole("button", { name: "保存并应用", exact: true }).click();
			await expect(json).toHaveCount(0);
			await settings.getByRole("combobox", { name: "主题", exact: true }).selectOption("light");
			await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
			expect(await readFile(configFile, "utf8")).toContain("保留我的注释");
			await page.screenshot({ path: `dist/gui-settings-${mode}-${info.project.name}.png` });
			await page.keyboard.press("Escape");
			const editor = page.getByRole("textbox", { name: "消息", exact: true });
			await editor.fill("换行测试");
			await editor.press("Enter");
			await expect(editor).toHaveValue("换行测试\n");
			await editor.fill("");
			await openSettings();
			await settings.getByRole("combobox", { name: "发送快捷键", exact: true }).selectOption("enter");
			await expect(settings.getByRole("combobox", { name: "发送快捷键", exact: true })).toHaveValue("enter");
			await page.keyboard.press("Escape");
			await editor.fill("换行测试");
			await editor.press("Shift+Enter");
			await expect(editor).toHaveValue("换行测试\n");
			await editor.fill("/name 快捷键验证");
			await editor.press("Enter");
			await expect(page.locator(".topbar .session-name")).toHaveText("快捷键验证");
			if (!phone) {
				const left = page.getByRole("separator", { name: "调整左侧栏宽度", exact: true });
				const right = page.getByRole("separator", { name: "调整右侧栏宽度", exact: true });
				const files = page.locator(".sidebar").getByRole("separator", { name: "调整会话与文件区域", exact: true });
				const conversation = page.getByRole("separator", { name: "调整对话宽度（左边缘）", exact: true });
				const width = (selector: string) => page.locator(selector).evaluate((element) => element.getBoundingClientRect().width);
				await page.mouse.move(5, 5);
				await expect.poll(() => conversation.evaluate((element) => getComputedStyle(element, "::after").opacity)).toBe("0");
				const grip = await conversation.boundingBox();
				if (!grip) throw new Error("对话边缘不可见");
				await page.mouse.move(grip.x + grip.width / 2, grip.y + 70);
				await expect.poll(() => conversation.evaluate((element) => Number(getComputedStyle(element, "::after").opacity))).toBeGreaterThan(0.8);
				await expect.poll(() => conversation.evaluate((element) => parseFloat(getComputedStyle(element, "::after").top))).toBeCloseTo(70, 0);
				await page.mouse.move(grip.x + grip.width / 2, grip.y + 120);
				await expect.poll(() => conversation.evaluate((element) => parseFloat(getComputedStyle(element, "::after").top))).toBeCloseTo(120, 0);
				await page.mouse.move(5, 5);
				await expect.poll(() => conversation.evaluate((element) => getComputedStyle(element, "::after").opacity)).toBe("0");
				const originalLeft = await width(".sidebar");
				const originalRight = await width(".session-sidebar");
				await drag(page, left, 40.5);
				await expect.poll(() => width(".sidebar")).toBeGreaterThan(originalLeft + 35);
				await drag(page, right, 30.5);
				await expect.poll(() => width(".session-sidebar")).toBeLessThan(originalRight - 20);
				await drag(page, files, 0, 60.5);
				await expect(files).not.toHaveAttribute("aria-valuenow", "55");
				const originalConversation = await width(".transcript-content");
				await drag(page, conversation, 45.5);
				await expect.poll(() => width(".transcript-content")).toBeLessThan(originalConversation - 80);
				await page.mouse.move(5, 5);
				await expect.poll(() => conversation.evaluate((element) => getComputedStyle(element, "::after").opacity)).toBe("0");
				const persisted = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith("opi.gui.layout."))));
				expect(Object.keys(persisted)).toHaveLength(4);
				const savedWidth = await width(".transcript-content");
				await page.reload();
				await expect.poll(() => width(".transcript-content")).toBeCloseTo(savedWidth, 0);
				await page.setViewportSize({ width: 390, height: 844 });
				await expect(conversation).toBeHidden();
				expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith("opi.gui.layout."))))).toEqual(persisted);
				await page.setViewportSize({ width: 1200, height: 820 });
				await expect(conversation).toBeVisible();
				await conversation.dblclick();
				expect(await page.evaluate(() => localStorage.getItem("opi.gui.layout.v1.conversation"))).toBeNull();
				await files.dblclick();
				await expect(files).toHaveAttribute("aria-valuenow", "55");
				await left.dblclick();
				await expect.poll(() => width(".sidebar")).toBeCloseTo(originalLeft, 0);
				await right.dblclick();
				await expect.poll(() => width(".session-sidebar")).toBeCloseTo(originalRight, 0);
				expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("opi.gui.layout.")))).toEqual([]);
				await page.screenshot({ path: `dist/gui-resize-${mode}.png` });
			}
			expect(errors).toEqual([]);
		} finally { await app.close(); }
	} finally {
		const process = child;
		if (process && process.exitCode === null) await new Promise<void>((resolve) => { process.once("exit", () => resolve()); process.kill("SIGTERM"); });
		await rm(home, { recursive: true, force: true });
	}
});
