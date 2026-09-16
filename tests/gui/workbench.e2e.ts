import { test, expect, _electron as electron } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { storeSession } from "./session-fixture.ts";
import { expectContinuousWrappedText } from "./file-preview-layout.ts";
import { expectActionHighlight, expectGitContrast } from "./workbench-row-states.ts";

test("工作台：会话搜索、文件树、Git 差异、折叠与右侧预览", async ({ viewport }, info) => {
	const home = await mkdtemp(path.join(os.tmpdir(), "opi-workbench-e2e-"));
	const cwd = path.join(home, "workspace");
	const agentDir = path.join(home, ".pi", "agent");
	await mkdir(path.join(cwd, "src"), { recursive: true });
	await mkdir(path.join(agentDir, "configs"), { recursive: true });
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }));
	await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
	const git = (...args: string[]) => promisify(execFile)("git", args, { cwd });
	await git("init", "-b", "main");
	await git("config", "user.name", "GUI Test");
	await git("config", "user.email", "gui@example.invalid");
	await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n");
	await writeFile(path.join(cwd, "src", "main.ts"), "export const answer = 1;\n");
	await writeFile(path.join(cwd, "deleted.txt"), "deleted content\n");
	await git("add", ".");
	await git("commit", "-m", "initial");
	await writeFile(path.join(cwd, "src", "main.ts"), "export const answer = 42;\n");
	await rm(path.join(cwd, "deleted.txt"));
	await mkdir(path.join(cwd, "node_modules", "pkg"), { recursive: true });
	await writeFile(path.join(cwd, "node_modules", "pkg", "index.js"), "ignored but readable\n");
	await writeFile(path.join(cwd, "引用 空格.md"), "# 项目\n\n本仓库提供基于 Pi 的 `opi` CLI，静态集成工具、命令和 TUI 增强。用户配置与会话继续使用 `~/.pi`，安装目录可以独立于配置目录。\n");
	await writeFile(path.join(cwd, "src", "long.ts"), Array.from({ length: 300 }, (_, index) => `export const row${index} = '${"long-content-".repeat(20)}';`).join("\n"));
	for (let index = 0; index < 20; index++) await writeFile(path.join(cwd, `file-${index}.txt`), `file ${index}\n`);
	for (let index = 0; index < 12; index++) await storeSession({ cwd, agentDir, provider: "gui-test", name: `历史任务 ${index}`, timestamp: Date.UTC(2026, 0, index + 1) });
	const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NODE_ENV: "test" };
	const child = spawn(path.resolve("dist", process.platform === "win32" ? "opi-web.exe" : "opi-web"), ["--cwd", cwd, "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
	child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
	try {
		await expect.poll(() => output.match(/opi-web: (http:\/\/[^\s]+)/)?.[1], { message: "工作台测试服务启动" }).toBeTruthy();
		const url = output.match(/opi-web: (http:\/\/[^\s]+)/)?.[1];
		if (!url) throw new Error(output);
		const app = await electron.launch({ args: [path.resolve("tests/gui/web-browser.cjs"), "--no-sandbox"], env });
		try {
			const page = await app.firstWindow();
			if (viewport) await page.setViewportSize(viewport);
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.goto(url);
			const phone = info.project.name === "phone";
			const openNavigation = async (files = false) => {
				if (phone && !await page.getByRole("dialog", { name: "工作空间导航", exact: true }).count()) await page.getByRole("button", { name: "菜单", exact: true }).click();
				if (phone) await page.locator(".mobile-sidebar .workbench-pane-tabs").getByRole("button", { name: files ? "文件" : "会话", exact: true }).click();
			};
			await openNavigation();
			const navigation = page.locator(phone ? ".mobile-sidebar" : ".sidebar");
			const search = navigation.getByRole("textbox", { name: "搜索会话", exact: true });
			await expect(navigation.locator(".history-session")).toHaveCount(13);
			await search.fill("历史任务 0");
			await expect(navigation.locator(".history-session")).toHaveCount(1);
			await expect(navigation.getByRole("button", { name: "历史任务 0", exact: true })).toBeVisible();
			for (const colorScheme of ["light", "dark"] as const) {
				await page.emulateMedia({ colorScheme });
				await expectActionHighlight(navigation.getByRole("button", { name: "重命名会话 历史任务 0", exact: true }));
				await expectActionHighlight(navigation.getByRole("button", { name: "删除会话 历史任务 0", exact: true }));
			}
			await search.fill("没有这条会话");
			await expect(navigation.getByText("没有匹配的会话", { exact: true })).toBeVisible();
			await search.fill("");
			await openNavigation(true);
			const tree = navigation.getByRole("tree", { name: "工作区文件", exact: true });
			await expect(tree.getByRole("treeitem", { name: "node_modules", exact: true })).toHaveAttribute("data-ignored", "true");
			await tree.getByRole("treeitem", { name: "node_modules", exact: true }).click();
			await tree.getByRole("treeitem", { name: "node_modules/pkg", exact: true }).click();
			await expect(tree.getByRole("treeitem", { name: "node_modules/pkg/index.js", exact: true })).toHaveAttribute("data-ignored", "true");
			await navigation.getByRole("button", { name: "折叠全部目录", exact: true }).click();
			await expect(tree.getByRole("treeitem", { name: "node_modules/pkg", exact: true })).toHaveCount(0);
			await expect(navigation.getByRole("button", { name: "文件操作", exact: true })).toHaveCount(0);
			for (const directory of ["src", "node_modules"]) {
				const directoryReference = tree.getByRole("button", { name: `引用路径 ${directory}`, exact: true });
				await expectActionHighlight(directoryReference);
				await directoryReference.click();
				await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(`@${directory} `);
				await page.getByRole("textbox", { name: "消息", exact: true }).fill("");
				await openNavigation(true);
				await expect(tree.getByRole("treeitem", { name: directory, exact: true })).toHaveAttribute("aria-expanded", "false");
			}
			await tree.getByRole("treeitem", { name: "src", exact: true }).focus();
			await page.keyboard.press("ArrowRight");
			await expect(tree.getByRole("treeitem", { name: "src/main.ts", exact: true })).toBeVisible();
			await expectGitContrast(page, tree);
			const reference = tree.getByRole("button", { name: "引用路径 src/main.ts", exact: true });
			await tree.getByRole("treeitem", { name: "src", exact: true }).focus();
			await navigation.locator(".workspace-files-heading").hover();
			await expect(reference.locator("..")).toHaveCSS("opacity", "0");
			await reference.focus();
			await expect(reference.locator("..")).toHaveCSS("opacity", "1");
			await tree.getByRole("treeitem", { name: "src", exact: true }).focus();
			await expectActionHighlight(reference);
			await reference.click();
			await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("@src/main.ts ");
			await expect(page.getByRole("tab", { name: "文件", exact: true })).toHaveCount(0);
			await page.getByRole("textbox", { name: "消息", exact: true }).fill("");
			await openNavigation(true);
			await tree.getByRole("treeitem", { name: "src", exact: true }).focus();
			await page.keyboard.press("ArrowRight");
			await expect(tree.getByRole("treeitem", { name: "src/long.ts", exact: true })).toBeFocused();
			await page.keyboard.press("ArrowDown");
			await expect(tree.getByRole("treeitem", { name: "src/main.ts", exact: true })).toBeFocused();
			await page.keyboard.press("Enter");
			const right = page.getByRole("complementary", { name: "会话信息", exact: true });
			await expect(right.getByRole("tab", { name: "文件", exact: true })).toHaveAttribute("aria-selected", "true");
			await expect(right.locator(".file-preview-body")).toContainText("export const answer = 42;");
			await expect(right.getByRole("button", { name: "差异", exact: true })).toHaveAttribute("aria-pressed", "true");
			await expect(right.locator(".file-preview-body")).toContainText("-export const answer = 1;");
			await expect(right.getByRole("button", { name: "展开文件预览", exact: true })).toHaveCount(0);
			await expect(right.getByRole("button", { name: "刷新预览", exact: true })).toHaveCount(0);
			await right.getByRole("button", { name: "内容", exact: true }).click();
			await expect(right.locator(".file-preview-body")).not.toContainText("-export const answer = 1;");
			await right.getByRole("button", { name: "差异", exact: true }).click();
			await right.getByRole("tab", { name: "会话树", exact: true }).click();
			await right.getByRole("tab", { name: "文件", exact: true }).click();
			await expect(right.getByRole("button", { name: "差异", exact: true })).toHaveAttribute("aria-pressed", "true");
			await openNavigation(true);
			await navigation.getByRole("button", { name: "显示文件变更", exact: true }).click();
			const changes = navigation.getByRole("list", { name: "工作区变更", exact: true });
			await expect(tree).toHaveCount(0);
			await expect(changes.getByRole("button", { name: "deleted.txt", exact: true })).toBeVisible();
			await expect(changes.getByRole("button", { name: "node_modules", exact: true })).toHaveCount(0);
			await expect(changes.getByRole("button", { name: "引用路径 deleted.txt", exact: true })).toHaveCount(0);
			const changeReference = changes.getByRole("button", { name: "引用路径 引用 空格.md", exact: true });
			await expectActionHighlight(changeReference);
			await changeReference.click();
			await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue('@"引用 空格.md" ');
			await expect(right.locator(".file-preview-path")).toHaveAttribute("title", "src/main.ts");
			await page.getByRole("textbox", { name: "消息", exact: true }).fill("");
			await openNavigation(true);
			await changes.getByRole("button", { name: "src/long.ts", exact: true }).click();
			await expect(right.locator(".file-preview-body")).toContainText("row299");
			const scroll = right.locator(".file-preview-body");
			const wrap = right.getByRole("button", { name: "自动折行", exact: true });
			await expect(wrap).toHaveAttribute("aria-pressed", "true");
			expect(await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
			await right.getByRole("button", { name: "内容", exact: true }).click();
			expect(await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
			await right.getByRole("button", { name: "差异", exact: true }).click();
			await wrap.click();
			await expect(wrap).toHaveAttribute("aria-pressed", "false");
			expect(await scroll.evaluate((element) => ({ vertical: element.scrollHeight > element.clientHeight, horizontal: element.scrollWidth > element.clientWidth,
				atTop: element.scrollTop === 0, bottomScrollbar: element.getBoundingClientRect().height > element.clientHeight,
				nestedScrollbars: [...element.querySelectorAll('pre')].some((pre) => getComputedStyle(pre).overflowX !== 'visible') })))
				.toEqual({ vertical: true, horizontal: true, atTop: true, bottomScrollbar: true, nestedScrollbars: false });
			await scroll.evaluate((element) => { element.scrollLeft = 80; element.scrollTop = 100; });
			await right.getByRole("tab", { name: "会话树", exact: true }).click();
			await right.getByRole("tab", { name: "文件", exact: true }).click();
			expect(await scroll.evaluate((element) => [element.scrollLeft, element.scrollTop])).toEqual([80, 100]);
			await openNavigation(true);
			await navigation.getByRole("button", { name: "收起文件区", exact: true }).click();
			await expect(changes).toHaveCount(0);
			if (!phone) {
				const fileRow = await navigation.locator(".workspace-files").boundingBox();
				const footer = await navigation.locator(".sidebar-footer").boundingBox();
				expect(fileRow && footer && Math.abs(fileRow.y + fileRow.height - footer.y) < 2).toBe(true);
			}
			await navigation.getByRole("button", { name: "展开文件区", exact: true }).click();
			await changes.getByRole("button", { name: "引用 空格.md", exact: true }).click();
			await expect(right.locator(".file-preview-path")).toHaveText("引用 空格.md");
			await right.getByRole("button", { name: "内容", exact: true }).click();
			await expectContinuousWrappedText(right.locator(".file-source-line").filter({ hasText: "本仓库提供" }));
			await right.getByRole("button", { name: "引用文件", exact: true }).click();
			await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue('@"引用 空格.md" ');
			await expect(page.locator(".message.user")).toHaveCount(0);
			await page.getByRole("textbox", { name: "消息", exact: true }).fill("");
			if (!phone) {
				const splitter = navigation.getByRole("separator", { name: "调整会话与文件区域", exact: true });
				await splitter.focus();
				await page.keyboard.press("ArrowDown");
				await expect(splitter).toHaveAttribute("aria-valuenow", "60");
			}
			for (const colorScheme of ["light", "dark"] as const) {
				await page.emulateMedia({ colorScheme });
				await page.screenshot({ path: path.resolve("dist", `gui-workbench-${colorScheme}-${info.project.name}.png`), animations: "disabled" });
			}
			await page.reload();
			await openNavigation();
			if (!phone) await expect(navigation.getByRole("separator", { name: "调整会话与文件区域", exact: true })).toHaveAttribute("aria-valuenow", "55");
			for (const size of [{ width: 320, height: 568 }, { width: 640, height: 360 }, { width: 1200, height: 820 }]) {
				await page.setViewportSize(size);
				await page.evaluate((font) => { document.documentElement.style.fontSize = font; }, size.width === 1200 ? "200%" : "100%");
				if (size.width < 768 && !await page.getByRole("dialog", { name: "工作空间导航", exact: true }).count()) await page.getByRole("button", { name: "菜单", exact: true }).click();
				const activeNavigation = page.locator(size.width < 768 ? ".mobile-sidebar" : ".sidebar");
				await expect(activeNavigation.getByRole("button", { name: "新建会话", exact: true })).toBeInViewport();
				const overflow = await activeNavigation.evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth,
					children: [...element.querySelectorAll('*')].filter((node) => node.getBoundingClientRect().width && node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === 'visible')
						.map((node) => ({ name: node.className, width: node.clientWidth, scroll: node.scrollWidth })) }));
				expect(overflow.scroll, JSON.stringify({ size, overflow })).toBeLessThanOrEqual(overflow.width);
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			}
			expect(errors).toEqual([]);
		} finally { await app.close(); }
	} finally {
		await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else { child.once("exit", () => resolve()); child.kill("SIGTERM"); } });
		await rm(home, { recursive: true, force: true });
	}
});
