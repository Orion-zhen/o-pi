import { mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, dialog, Menu, powerMonitor, powerSaveBlocker, session, shell } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopFile, openDesktopFile, prepareFileDrop, showFileMenu, startFileDrag } from "../../src/desktop/file-integration.ts";
import { installDesktopMenu } from "../../src/desktop/menu.ts";
import { DesktopTaskStatus } from "../../src/desktop/task-status.ts";
import { installDesktopPower } from "../../src/desktop/power.ts";
import type { GuiSessionActivity } from "../../src/gui/shared/protocol/state.ts";
import { useTempDir } from "../helpers/lifecycle.ts";

vi.mock("electron", async () => {
	const { EventEmitter } = await import("node:events");
	const image = {};
	return {
		app: { name: "opi-desktop", dock: { setBadge: vi.fn() }, setBadgeCount: vi.fn(), addRecentDocument: vi.fn(), getFileIcon: vi.fn(async () => image) },
		nativeImage: { createFromPath: vi.fn(() => image) },
		clipboard: { writeText: vi.fn() },
		dialog: { showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })) },
		shell: { openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() },
		Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })), setApplicationMenu: vi.fn() },
		powerMonitor: new EventEmitter(),
		powerSaveBlocker: { start: vi.fn(() => 5), stop: vi.fn() },
		session: { defaultSession: { forceReloadProxyConfig: vi.fn(async () => {}) } },
		BrowserWindow: class {
			webContents = Object.assign(new EventEmitter(), { startDrag: vi.fn(), send: vi.fn(), replaceMisspelling: vi.fn(),
				session: { addWordToSpellCheckerDictionary: vi.fn() } });
			setOverlayIcon = vi.fn(); isDestroyed() { return false; }
		},
	};
});
const originalPlatform = process.platform;
beforeEach(() => vi.clearAllMocks());
afterEach(() => { Object.defineProperty(process, "platform", { value: originalPlatform }); });
const temp = useTempDir("opi-native-");

async function files() {
	const root = path.join(temp.path, "workspace");
	await mkdir(root, { recursive: true });
	await writeFile(path.join(root, "你好 world.txt"), "hello");
	const external = path.join(temp.path, "outside.txt");
	await writeFile(external, "outside");
	return { root: await realpath(root), external: await realpath(external) };
}

function click(label: string) {
	const template = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)?.[0];
	const item = template?.find((item) => "label" in item && item.label === label);
	if (!item || typeof item.click !== "function") throw new Error(`菜单项不存在: ${label}`);
	Reflect.apply(item.click, undefined, []);
}

describe("原生文件流转", () => {
	it("工作区内引用原文件，外部文件和虚拟文件保留附件语义", async () => {
		const { root, external } = await files();
		expect(await prepareFileDrop(new BrowserWindow(), root, [path.join(root, "你好 world.txt"), root, external, ""])).toEqual([
			{ kind: "reference", path: "你好 world.txt" }, { kind: "reference", path: "." }, { kind: "attachment" }, { kind: "attachment" },
		]);
	});
	it("符号链接不扩大工作区访问，目录打开需显式选择", async () => {
		const { root, external } = await files();
		const window = new BrowserWindow();
		await symlink(external, path.join(root, "outside-link"));
		expect(await prepareFileDrop(window, root, [path.join(root, "outside-link")])).toEqual([{ kind: "attachment" }]);
		await expect(desktopFile(root, "outside-link")).rejects.toThrow("超出当前工作区");
		await expect(desktopFile(root, "../outside.txt")).rejects.toThrow("超出当前工作区");
		const directory = await realpath(temp.path);
		expect(await prepareFileDrop(window, root, [directory])).toEqual([]);
		vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false });
		expect(await prepareFileDrop(window, root, [directory])).toEqual([{ kind: "workspace", path: directory }]);
		vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 2, checkboxChecked: false });
		expect(await prepareFileDrop(window, root, [directory])).toEqual([{ kind: "reference", path: directory }]);
		await expect(prepareFileDrop(window, root, [temp.path, external])).rejects.toThrow("单独拖入");
		expect(dialog.showMessageBox).toHaveBeenCalledTimes(3);
	});
	it("文件菜单调用系统打开、定位和复制，拖出使用原文件", async () => {
		const { root } = await files();
		const file = await desktopFile(root, "你好 world.txt");
		const window = new BrowserWindow();
		const report = vi.fn();
		await showFileMenu(window, file, report);
		click("复制绝对路径");
		expect(clipboard.writeText).toHaveBeenCalledWith(file);
		click(process.platform === "darwin" ? "在 Finder 中显示" : "在文件管理器中显示");
		expect(shell.showItemInFolder).toHaveBeenCalledWith(file);
		click("使用默认应用打开");
		await vi.waitFor(() => expect(shell.openPath).toHaveBeenCalledWith(file));
		await startFileDrag(window, file);
		expect(window.webContents.startDrag).toHaveBeenCalledWith({ file, icon: expect.anything() });
		vi.mocked(shell.openPath).mockResolvedValueOnce("no associated application");
		await expect(openDesktopFile(file)).rejects.toThrow("no associated application");
	});
});

function activity(id: string, state: GuiSessionActivity["state"], completedAt = 0): GuiSessionActivity {
	return { sessionId: id, state, completedAt, path: null, cwd: "/work", title: id, modified: "" };
}
function expectBadge(count: number, window: BrowserWindow) {
	if (process.platform === "darwin") expect(app.dock?.setBadge).toHaveBeenLastCalledWith(count ? String(count) : "");
	else if (process.platform === "win32") expect(window.setOverlayIcon).toHaveBeenLastCalledWith(count ? expect.anything() : null, count ? `${count} 个会话待处理或未读` : "");
	else expect(app.setBadgeCount).toHaveBeenLastCalledWith(count);
}

describe("任务状态与电源", () => {
	it.each(["darwin", "win32", "linux"])("%s 任务结束产生未读徽标，阅读清除结果但不清除待处理审批", (platform) => {
		Object.defineProperty(process, "platform", { value: platform });
		const window = new BrowserWindow();
		const status = new DesktopTaskStatus(window, fileURLToPath(new URL("../../assets/icons/attention.png", import.meta.url)));
		expect(status.update([activity("a", "running"), activity("b", "waiting")])).toBe(true);
		expectBadge(1, window);
		expect(status.update([activity("a", "idle", 100), activity("b", "waiting", 80)])).toBe(false);
		expectBadge(2, window);
		status.markRead("b", 80);
		expectBadge(2, window);
		status.markRead("a", 100);
		expectBadge(1, window);
		status.update([activity("a", "idle", 100), activity("b", "idle", 80)]);
		expectBadge(0, window);
		status.update([activity("a", "idle", 200)]);
		expectBadge(1, window);
		status.clear();
		expectBadge(0, window);
	});
	it("防睡眠默认关闭，运行时单次持有，等待、禁用和退出立即释放", () => {
		const power = installDesktopPower(vi.fn(), vi.fn());
		try {
			power.activity(true);
			expect(powerSaveBlocker.start).not.toHaveBeenCalled();
			power.configure(true);
			power.activity(true);
			expect(powerSaveBlocker.start).toHaveBeenCalledExactlyOnceWith("prevent-app-suspension");
			power.activity(false);
			expect(powerSaveBlocker.stop).toHaveBeenCalledWith(5);
			power.activity(true);
			power.configure(false);
			expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(2);
			power.configure(true);
		} finally { power.dispose(); }
		expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(3);
		expect(powerMonitor.listenerCount("resume")).toBe(0);
	});
	it("休眠释放阻止器，唤醒刷新代理与界面", () => {
		const resume = vi.fn();
		const notice = vi.fn();
		const power = installDesktopPower(resume, notice);
		try {
			power.configure(true); power.activity(true);
			powerMonitor.emit("suspend");
			expect(powerSaveBlocker.stop).toHaveBeenCalledWith(5);
			expect(notice).toHaveBeenCalledWith(expect.stringContaining("网络请求可能中断"));
			powerMonitor.emit("resume");
			expect(resume).toHaveBeenCalledOnce();
			expect(session.defaultSession.forceReloadProxyConfig).toHaveBeenCalledOnce();
			expect(powerSaveBlocker.start).toHaveBeenCalledTimes(2);
		} finally { power.dispose(); }
	});
});

describe("原生菜单", () => {
	it("macOS 菜单新建会话，并从更新后的最近工作区导航", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		const window = new BrowserWindow();
		const open = vi.fn();
		const menu = installDesktopMenu(window, open);
		expect(Menu.setApplicationMenu).toHaveBeenCalledExactlyOnceWith(vi.mocked(Menu.buildFromTemplate).mock.results[0]?.value);
		const paths = [{ path: "/first", exists: true }, { path: "/current", exists: true }, { path: "/missing", exists: false }];
		menu.workspaces(paths);
		menu.select("/current");
		menu.select("/current");
		expect(app.addRecentDocument).toHaveBeenCalledExactlyOnceWith("/current");
		menu.workspaces([...paths, { path: "/new", exists: true }]);
		const template = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)?.[0];
		const file = template?.find((item) => item.label === "文件");
		if (!file || !Array.isArray(file.submenu)) throw new Error("缺少文件菜单");
		const create = file.submenu.find((item) => item.label === "新建会话");
		expect(create?.accelerator).toBe("CmdOrCtrl+N");
		if (!create?.click) throw new Error("缺少新建会话命令");
		Reflect.apply(create.click, undefined, []);
		expect(window.webContents.send).toHaveBeenCalledWith("gui:command", "new");
		expect(file.submenu.some((item) => item.role === "close")).toBe(true);
		const recent = file.submenu.find((item) => item.label === "最近工作区");
		if (!Array.isArray(recent?.submenu)) throw new Error("缺少最近工作区");
		expect(recent.submenu.map((item) => item.label)).toEqual(["/current", "/first", "/new"]);
		const item = recent.submenu[0];
		if (!item?.click) throw new Error("缺少工作区入口");
		Reflect.apply(item.click, undefined, []);
		expect(open).toHaveBeenCalledWith("/current");
	});
	it.each(["win32", "linux"])("%s 移除应用菜单，工作区更新不重新创建", (platform) => {
		Object.defineProperty(process, "platform", { value: platform });
		const menu = installDesktopMenu(new BrowserWindow(), vi.fn());
		expect(Menu.setApplicationMenu).toHaveBeenCalledExactlyOnceWith(null);
		menu.workspaces([{ path: "/work", exists: true }]);
		menu.select("/work");
		expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
		expect(vi.mocked(Menu.setApplicationMenu).mock.calls).toEqual([[null], [null], [null]]);
	});
	it.each(["darwin", "win32", "linux"])("%s 输入框右键提供拼写替换和标准编辑能力", (platform) => {
		Object.defineProperty(process, "platform", { value: platform });
		const window = new BrowserWindow();
		installDesktopMenu(window, vi.fn());
		window.webContents.emit("context-menu", {}, { isEditable: true, misspelledWord: "helo", dictionarySuggestions: ["hello"],
			editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true } });
		click("hello");
		expect(window.webContents.replaceMisspelling).toHaveBeenCalledWith("hello");
		click("添加到词典");
		expect(window.webContents.session.addWordToSpellCheckerDictionary).toHaveBeenCalledWith("helo");
	});
});
