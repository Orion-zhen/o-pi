import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../gui/shared/protocol/desktop.ts";
import type { GuiDelivery } from "../gui/shared/protocol/sync.ts";

const bridge: DesktopBridge = {
	attend: (sessionId) => ipcRenderer.send("gui:attention", sessionId),
	reportDiagnostic: (value) => ipcRenderer.invoke("gui:diagnostic", value),
	readStorage: () => ipcRenderer.invoke("gui:storage"),
	clearStorage: (ids) => ipcRenderer.invoke("gui:clearStorage", ids),
	setAppearance: (value) => ipcRenderer.invoke("gui:appearance", value),
	send: (value, sessionId) => ipcRenderer.invoke("gui:action", { value, sessionId }, Date.now()),
	query: (value, sessionId) => ipcRenderer.invoke("gui:query", { value, sessionId }),
	acknowledge: (id) => ipcRenderer.send("gui:ack", id, Date.now()),
	subscribe(listener) {
		const handle = (_event: Electron.IpcRendererEvent, value: GuiDelivery, traced: boolean) => {
			if (traced && value.kind === "frame") ipcRenderer.send("gui:received", value.id, Date.now());
			listener(value);
		};
		ipcRenderer.on("gui:event", handle);
		ipcRenderer.send("gui:subscribe");
		return () => ipcRenderer.removeListener("gui:event", handle);
	},
	close() {
		ipcRenderer.send("gui:unsubscribe");
	},
	chooseDirectory: () => ipcRenderer.invoke("gui:directory"),
	openExternal: (url) => ipcRenderer.invoke("gui:external", url),
	openFile: (cwd, path) => ipcRenderer.invoke("gui:openFile", cwd, path),
};
contextBridge.exposeInMainWorld("opi", bridge);
