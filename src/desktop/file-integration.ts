import { app, clipboard, dialog, Menu, shell, type BrowserWindow } from "electron";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { workspacePath } from "../gui/host/workspace/workspace-path.ts";
import type { DesktopDrop } from "../gui/shared/protocol/desktop.ts";

export async function desktopFile(cwd: unknown, name: unknown): Promise<string> {
	if (typeof cwd !== "string" || !path.isAbsolute(cwd) || typeof name !== "string") throw new Error("无效文件路径");
	return workspacePath(cwd, name);
}

export async function openDesktopFile(file: string): Promise<void> {
	if (!(await stat(file)).isFile()) throw new Error("仅支持打开普通文件。");
	const error = await shell.openPath(file);
	if (error) throw new Error(error);
}

export async function showFileMenu(window: BrowserWindow, file: string, report: (error: unknown) => void): Promise<void> {
	const info = await stat(file);
	Menu.buildFromTemplate([
		{ label: process.platform === "darwin" ? "在 Finder 中显示" : "在文件管理器中显示", click: () => shell.showItemInFolder(file) },
		{ label: "使用默认应用打开", enabled: info.isFile(), click: () => { void openDesktopFile(file).catch(report); } },
		{ type: "separator" },
		{ label: "复制绝对路径", click: () => clipboard.writeText(file) },
	]).popup({ window });
}

export async function startFileDrag(window: BrowserWindow, file: string): Promise<void> {
	if (!(await stat(file)).isFile()) throw new Error("仅支持拖出普通文件。");
	const icon = await app.getFileIcon(file, { size: "normal" });
	if (!window.isDestroyed()) window.webContents.startDrag({ file, icon });
}

/** 只返回用户拖入项的引用，不读取文件内容，也不扩展工作区权限。 */
export async function prepareFileDrop(window: BrowserWindow, cwd: unknown, values: unknown): Promise<DesktopDrop[]> {
	if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !Array.isArray(values) || values.length > 256
		|| !values.every((value): value is string => typeof value === "string" && (value === "" || path.isAbsolute(value))))
		throw new Error("无效拖入文件");
	const root = await realpath(cwd);
	const items = await Promise.all(values.map(async (file): Promise<DesktopDrop | null> => {
		if (!file) return { kind: "attachment" };
		const target = await realpath(file);
		const info = await stat(target);
		if (!info.isFile() && !info.isDirectory()) throw new Error("仅支持普通文件或文件夹。");
		const relative = path.relative(root, target);
		if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
			return { kind: "reference", path: relative.split(path.sep).join("/") || "." };
		if (info.isDirectory()) {
			if (values.length !== 1) throw new Error("外部文件夹请单独拖入。");
			const { response } = await dialog.showMessageBox(window, {
				type: "question", message: "如何使用拖入的文件夹？", detail: target,
				buttons: ["取消", "打开工作区", "插入目录引用"], defaultId: 0, cancelId: 0, noLink: true,
			});
			return response === 1 || response === 2 ? { kind: response === 1 ? "workspace" : "reference", path: target } : null;
		}
		return { kind: "attachment" };
	}));
	return items.filter((item) => item !== null);
}
