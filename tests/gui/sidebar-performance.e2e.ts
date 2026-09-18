import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixture.ts";
import { storeSession } from "./session-fixture.ts";
import { clickRowAction } from "./row-actions.ts";

test.beforeEach(async ({ workspace: { cwd, agentDir } }) => {
	await promisify(execFile)("git", ["init", "-b", "main"], { cwd });
	await Promise.all(Array.from({ length: 400 }, (_, index) => storeSession({
		cwd, agentDir, provider: "gui-test", name: `历史-${String(index).padStart(4, "0")}`, timestamp: 1000 + index,
	})));
	await Promise.all(Array.from({ length: 1000 }, (_, index) => writeFile(path.join(cwd, `file-${String(index).padStart(4, "0")}.txt`), `file ${index}\n`)));
	await mkdir(path.join(cwd, "src", "deep"), { recursive: true });
	await writeFile(path.join(cwd, "src", "deep", "main.ts"), "export {};\n");
});

test("大列表限制挂载数量，搜索、改名、键盘跨视口导航和文件预览仍可用", async ({ gui: { page }, workspace: { cwd, agentDir } }, info) => {
	const phone = info.project.name === "phone";
	const navigation = page.locator(phone ? ".mobile-sidebar" : ".sidebar");
	if (phone) await page.getByRole("button", { name: "菜单", exact: true }).click();
	const history = navigation.getByRole("region", { name: "历史会话", exact: true });
	await expect(history.getByRole("button", { name: "历史-0399", exact: true })).toBeVisible();
	expect(await history.locator(".history-session-row").count()).toBeLessThan(80);
	const scroll = history.locator("[data-list-scroll]");
	await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
	await expect(history.getByRole("button", { name: "历史-0000", exact: true })).toBeVisible();
	expect(await history.locator(".history-session-row").count()).toBeLessThan(80);
	await clickRowAction(history.getByRole("button", { name: "重命名会话 历史-0000", exact: true }));
	const name = history.getByRole("textbox", { name: "会话名称", exact: true });
	await name.fill("已修改-0000");
	await scroll.evaluate((element) => { element.scrollTop = 0; });
	await expect(name).toBeAttached();
	await storeSession({ cwd, agentDir, provider: "gui-test", name: "外部新增历史" });
	const refreshed = page.waitForResponse((response) => {
		if (!response.url().endsWith("/api/action")) return false;
		const body: unknown = response.request().postDataJSON();
		return typeof body === "object" && body !== null && "action" in body && body.action === "sessions";
	});
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await refreshed;
	await expect(name).toHaveValue("已修改-0000");
	await scroll.evaluate((element) => { element.scrollTop = 0; });
	await expect(history.getByRole("button", { name: "外部新增历史", exact: true })).toBeVisible();
	await name.press("Enter");
	const search = navigation.getByRole("textbox", { name: "搜索会话", exact: true });
	await search.fill("已修改-0000");
	await expect(history.getByRole("button", { name: "已修改-0000", exact: true })).toBeVisible();
	await search.fill("");

	if (phone) await navigation.getByRole("button", { name: "文件", exact: true }).click();
	const tree = navigation.getByRole("tree", { name: "工作区文件", exact: true });
	await expect(tree.getByRole("treeitem", { name: "src", exact: true })).toBeVisible();
	expect(await tree.getByRole("treeitem").count()).toBeLessThan(80);
	await tree.getByRole("treeitem", { name: "src", exact: true }).focus();
	await page.keyboard.press("End");
	const last = tree.getByRole("treeitem", { name: "file-0999.txt", exact: true });
	await expect(last).toBeFocused();
	await expect(last).toBeVisible();
	expect(await tree.getByRole("treeitem").count()).toBeLessThan(80);
	await page.keyboard.press("Home");
	await expect(tree.getByRole("treeitem", { name: "src", exact: true })).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(tree.getByRole("treeitem", { name: "src/deep", exact: true })).toBeVisible();
	await page.keyboard.press("ArrowRight");
	await expect(tree.getByRole("treeitem", { name: "src/deep", exact: true })).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(tree.getByRole("treeitem", { name: "src", exact: true })).toBeFocused();
	await page.keyboard.press("End");
	await expect(last).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.locator(".file-preview-body")).toContainText("file 999");
	if (phone) {
		await page.getByRole("button", { name: "菜单", exact: true }).click();
		await navigation.getByRole("button", { name: "文件", exact: true }).click();
	}
	await navigation.getByRole("button", { name: "显示文件变更", exact: true }).click();
	const changes = navigation.getByRole("list", { name: "工作区变更", exact: true });
	await expect(changes.getByRole("button", { name: "file-0000.txt", exact: true })).toBeVisible();
	expect(await changes.locator(".file-change-row").count()).toBeLessThan(80);
	await navigation.locator(".workspace-files-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
	await expect(changes.getByRole("button", { name: "src/deep/main.ts", exact: true })).toBeVisible();
	await clickRowAction(changes.getByRole("button", { name: "引用路径 src/deep/main.ts", exact: true }));
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("@src/deep/main.ts ");
});

test("输入草稿不重新渲染历史行，连续刷新合并读取", async ({ gui: { page } }, info) => {
	test.skip(info.project.name === "phone", "桌面侧栏与编辑器同时可见");
	const navigation = page.locator(".sidebar");
	await expect(navigation.getByRole("button", { name: "历史-0399", exact: true })).toBeVisible();
	await expect(navigation.getByRole("button", { name: "刷新会话", exact: true })).toBeEnabled();
	await page.evaluate(() => {
		const descriptor = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format");
		if (!descriptor?.get) throw new Error("缺少日期格式化接口");
		const get = descriptor.get;
		document.documentElement.dataset.dateFormats = "0";
		Object.defineProperty(Intl.DateTimeFormat.prototype, "format", { ...descriptor, get() {
			const format: (value?: number | Date) => string = get.call(this);
			return (value?: number | Date) => {
				document.documentElement.dataset.dateFormats = String(Number(document.documentElement.dataset.dateFormats) + 1);
				return format(value);
			};
		} });
	});
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("输入草稿不应重绘侧栏");
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
	expect(await page.locator("html").getAttribute("data-date-formats")).toBe("0");

	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let requests = 0;
	let completed = 0;
	await page.route("**/api/query", async (route) => {
		const body: unknown = route.request().postDataJSON();
		if (typeof body === "object" && body !== null && "query" in body && body.query === "workspaceFiles") {
			requests++;
			await gate;
			const response = await route.fetch();
			await route.fulfill({ response });
			completed++;
		} else await route.continue();
	});
	const refresh = navigation.getByRole("button", { name: "刷新文件", exact: true });
	await refresh.evaluate((element: HTMLButtonElement) => { for (let index = 0; index < 10; index++) element.click(); });
	await expect.poll(() => requests).toBe(1);
	release?.();
	await expect.poll(() => completed).toBe(2);
	expect(requests).toBe(2);
});
