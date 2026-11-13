import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { BackendClient } from "./backend-client.ts";
import type { DesktopDiagnostics } from "./diagnostics.ts";
import type { DesktopTaskStatus } from "./task-status.ts";
import { installDesktopAppearance } from "./appearance.ts";
import { installDesktopFaults } from "./faults.ts";
import { desktopFile, openDesktopFile, prepareFileDrop, showFileMenu, startFileDrag } from "./file-integration.ts";
import { trackDesktopAttention } from "./notifications.ts";
import { desktopEntryUrl } from "./protocol.ts";
import { DesktopStorage } from "./storage.ts";

export function installDesktopIpc(
	window: BrowserWindow,
	client: BackendClient,
	diagnostics: DesktopDiagnostics,
	taskStatus: DesktopTaskStatus,
	openExternal: (url: string) => Promise<void>,
): void {
	function trusted(event: IpcMainInvokeEvent): void {
		if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== desktopEntryUrl)
			throw new Error("Untrusted renderer");
	}
	const storage = new DesktopStorage(diagnostics);
	const reportDiagnostic = installDesktopFaults(window, diagnostics);
	const setAppearance = installDesktopAppearance(window);
	const reportOperation = (error: unknown) => client.send({ kind: "feedback", message: error instanceof Error ? error.message : String(error), tone: "error" });
	const reportAttention = trackDesktopAttention(window, (value) => client.send({ kind: "attention", value }));

	ipcMain.handle("gui:storage", (event) => { trusted(event); return storage.read(); });
	ipcMain.handle("gui:clearStorage", (event, ids: unknown) => { trusted(event); return storage.clear(ids); });
	ipcMain.handle("gui:diagnostic", (event, value: unknown) => { trusted(event); return reportDiagnostic(value); });
	ipcMain.handle("gui:appearance", (event, value: unknown) => { trusted(event); return setAppearance(value); });
	ipcMain.on("gui:markRead", (event, id: unknown, at: unknown) => { trusted(event); taskStatus.markRead(id, at); });
	ipcMain.handle("gui:fileMenu", async (event, cwd: unknown, name: unknown) => {
		trusted(event); await showFileMenu(window, await desktopFile(cwd, name), reportOperation);
	});
	ipcMain.handle("gui:startDrag", async (event, cwd: unknown, name: unknown) => {
		trusted(event); await startFileDrag(window, await desktopFile(cwd, name));
	});
	ipcMain.handle("gui:drop", async (event, cwd: unknown, files: unknown) => {
		trusted(event); return prepareFileDrop(window, cwd, files);
	});
	for (const kind of ["action", "query"] as const) {
		ipcMain.handle(`gui:${kind}`, (event, value: unknown, submittedAt: unknown) => {
			trusted(event);
			return client.request({ kind, value }, submittedAt);
		});
	}
	ipcMain.on("gui:subscribe", (event) => {
		trusted(event);
		diagnostics.reset();
		client.send({ kind: "subscribe" });
		reportAttention();
	});
	ipcMain.on("gui:received", (event, id: unknown, at: unknown) => {
		trusted(event);
		if (typeof id !== "number" || !Number.isSafeInteger(id) || typeof at !== "number" || !Number.isFinite(at)) throw new Error("无效接收时间");
		diagnostics.received(id, at);
	});
	ipcMain.on("gui:ack", (event, id: unknown, appliedAt: unknown) => {
		trusted(event);
		if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new Error("无效确认序号");
		diagnostics.acknowledge(id, appliedAt);
		client.send({ kind: "ack", id });
	});
	ipcMain.on("gui:unsubscribe", (event) => {
		trusted(event);
		diagnostics.reset();
		client.send({ kind: "unsubscribe" });
	});
	ipcMain.handle("gui:directory", async (event) => {
		trusted(event);
		const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
		return result.canceled ? null : (result.filePaths[0] ?? null);
	});
	ipcMain.handle("gui:external", async (event, url: unknown) => {
		trusted(event);
		if (typeof url !== "string") throw new Error("无效 URL");
		await openExternal(url);
	});
	ipcMain.handle("gui:openFile", async (event, cwd: unknown, name: unknown) => {
		trusted(event);
		await openDesktopFile(await desktopFile(cwd, name));
	});
}
