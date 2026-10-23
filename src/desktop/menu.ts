import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { DesktopCommand } from "../gui/shared/protocol/desktop.ts";
import type { GuiWorkspaceInfo } from "../gui/shared/protocol/state.ts";

export function installDesktopMenu(window: BrowserWindow, openWorkspace: (path?: string) => void) {
	let workspaces: GuiWorkspaceInfo[] = [];
	let currentDirectory: string | undefined;
	const command = (value: DesktopCommand) => window.webContents.send("gui:command", value);
	const settings: MenuItemConstructorOptions = { label: "设置…", accelerator: "CmdOrCtrl+,", click: () => command("settings") };
	const update = () => {
		const recent: MenuItemConstructorOptions[] = workspaces.filter((item) => item.exists)
			.sort((a, b) => Number(b.path === currentDirectory) - Number(a.path === currentDirectory)).slice(0, 12).map((item) => ({
				label: item.path.replaceAll("&", "&&"), click: () => openWorkspace(item.path),
			}));
		Menu.setApplicationMenu(Menu.buildFromTemplate([
			...(process.platform === "darwin" ? [{ label: app.name, submenu: [
				{ role: "about" }, { type: "separator" }, settings, { type: "separator" },
				{ role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" },
				{ role: "unhide" }, { type: "separator" }, { role: "quit" },
			] } satisfies MenuItemConstructorOptions] : []),
			{ label: "文件", submenu: [
				{ label: "新建会话", accelerator: "CmdOrCtrl+N", click: () => command("new") },
				{ label: "打开工作区…", accelerator: "CmdOrCtrl+O", click: () => openWorkspace() },
				{ label: "最近工作区", submenu: recent.length ? recent : [{ label: "无最近工作区", enabled: false }] },
				...(process.platform === "darwin" ? [] : [settings]),
				{ type: "separator" }, { role: "close" },
				...(process.platform === "darwin" ? [] : [{ role: "quit" } satisfies MenuItemConstructorOptions]),
			] },
			{ label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" },
				{ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "pasteAndMatchStyle" }, { role: "selectAll" }] },
			{ label: "视图", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
				{ type: "separator" }, { role: "togglefullscreen" }] },
			{ role: "windowMenu", label: "窗口" },
		]));
	};
	update();
	window.webContents.on("context-menu", (_event, params) => {
		if (!params.isEditable && !params.selectionText) return;
		const items: MenuItemConstructorOptions[] = [];
		if (params.isEditable && params.misspelledWord) {
			for (const word of params.dictionarySuggestions) items.push({ label: word, click: () => window.webContents.replaceMisspelling(word) });
			items.push({ label: "添加到词典", click: () => window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: "separator" });
		}
		if (params.isEditable) items.push({ role: "undo", enabled: params.editFlags.canUndo }, { role: "redo", enabled: params.editFlags.canRedo }, { type: "separator" },
			{ role: "cut", enabled: params.editFlags.canCut });
		items.push({ role: "copy", enabled: params.editFlags.canCopy });
		if (params.isEditable) items.push({ role: "paste", enabled: params.editFlags.canPaste }, { role: "selectAll", enabled: params.editFlags.canSelectAll });
		Menu.buildFromTemplate(items).popup({ window });
	});
	return {
		workspaces(value: GuiWorkspaceInfo[]) { workspaces = value; update(); },
		select(cwd: string) {
			if (cwd !== currentDirectory) app.addRecentDocument(cwd);
			currentDirectory = cwd;
			update();
		},
	};
}
