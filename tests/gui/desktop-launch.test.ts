import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { app } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDesktopLaunch, launchAction } from "../../src/desktop/launch.ts";
import type { GuiAction } from "../../src/gui/shared/protocol/actions.ts";
import { useTempDir } from "../helpers/lifecycle.ts";

vi.mock("electron", async () => {
	const { EventEmitter } = await import("node:events");
	return { app: Object.assign(new EventEmitter(), { isPackaged: false, whenReady: async () => {} }) };
});
const argv = process.argv;
beforeEach(() => { process.argv = ["electron", "app"]; });
afterEach(() => { process.argv = argv; app.removeAllListeners(); });
const workspace = path.resolve("工作区 with spaces");
const session = path.join(workspace, "task.jsonl");
const temp = useTempDir("opi-launch-");

describe("Desktop 系统入口", () => {
	it("冷启动等待后端，系统链接和第二实例依次导航并聚焦已有窗口", async () => {
		process.argv = ["electron", "app", "--workspace", workspace];
		const first = Promise.withResolvers<void>();
		const open = vi.fn<(action: GuiAction) => Promise<void>>().mockResolvedValue(undefined).mockReturnValueOnce(first.promise);
		const focus = vi.fn();
		const report = vi.fn();
		const launch = installDesktopLaunch(focus, report);
		const preventDefault = vi.fn();
		app.emit("open-url", { preventDefault }, "opi-desktop://session?id=second");
		expect(preventDefault).toHaveBeenCalledOnce();
		await Promise.resolve();
		expect(open).not.toHaveBeenCalled();
		launch.ready(async (target) => { await open(await launchAction(target)); });
		await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith({ action: "workspace", path: workspace }));
		app.emit("second-instance", {}, ["electron", "app", "--session", "task.jsonl"], workspace);
		expect(focus).toHaveBeenCalledTimes(2);
		expect(open).toHaveBeenCalledOnce();
		first.resolve();
		await vi.waitFor(() => expect(open.mock.calls).toEqual([
			[{ action: "workspace", path: workspace }], [{ action: "openSession", id: "second" }], [{ action: "openSession", path: session }],
		]));
		expect(report).not.toHaveBeenCalled();
	});
	it("系统文件关联按文件类型打开，file URL 保留含空格的路径", async () => {
		const directory = path.join(temp.path, "工作区 with spaces");
		const file = path.join(directory, "task.jsonl");
		await mkdir(directory);
		await writeFile(file, "");
		process.argv = ["electron", "app", pathToFileURL(file).href];
		const open = vi.fn();
		const report = vi.fn();
		const launch = installDesktopLaunch(vi.fn(), report);
		launch.ready(async (target) => { open(await launchAction(target)); });
		app.emit("open-file", { preventDefault: vi.fn() }, directory);
		app.emit("second-instance", {}, ["electron", "app", file], directory);
		await vi.waitFor(() => expect(open.mock.calls).toEqual([
			[{ action: "openSession", path: file }], [{ action: "workspace", path: directory }], [{ action: "openSession", path: file }],
		]));
		expect(report).not.toHaveBeenCalled();
	});
	it("外部链接拒绝命令、额外参数和相对路径，之后仍能打开合法目标", async () => {
		const open = vi.fn();
		const report = vi.fn();
		const launch = installDesktopLaunch(vi.fn(), report);
		launch.ready(async (target) => { open(await launchAction(target)); });
		const invalid = ["opi://app/index.html", "opi-desktop://command?text=rm", "opi-desktop://workspace?path=relative",
			"opi-desktop://workspace?path=/tmp&command=run", "opi-desktop://workspace?path=/tmp&path=/other",
			"opi-desktop://session?id=", "opi-desktop://session?id=x#run", "opi-desktop://user@session?id=x", "opi-desktop://session/run?id=x"];
		for (const url of invalid) app.emit("open-url", { preventDefault: vi.fn() }, url);
		app.emit("open-url", { preventDefault: vi.fn() }, `opi-desktop://workspace?path=${encodeURIComponent(workspace)}`);
		app.emit("open-url", { preventDefault: vi.fn() }, `opi-desktop://session?path=${encodeURIComponent(session)}`);
		await vi.waitFor(() => expect(open.mock.calls).toEqual([
			[{ action: "workspace", path: workspace }], [{ action: "openSession", path: session }],
		]));
		expect(report).toHaveBeenCalledTimes(invalid.length);
	});
	it("文件已删除导致导航失败后，第二实例仍可打开工作区", async () => {
		const open = vi.fn();
		const report = vi.fn();
		const launch = installDesktopLaunch(vi.fn(), report);
		launch.ready(async (target) => { open(await launchAction(target)); });
		app.emit("open-file", { preventDefault: vi.fn() }, path.join(temp.path, "missing.jsonl"));
		app.emit("second-instance", {}, ["electron", "app", "--workspace", "子目录"], workspace);
		await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith({ action: "workspace", path: path.join(workspace, "子目录") }));
		expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "ENOENT" }));
	});
});
