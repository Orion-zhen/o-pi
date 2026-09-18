import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../gui/contract.ts";
import type { GuiDelivery } from "../gui/sync.ts";

const bridge: DesktopBridge = {
	send: (action) => ipcRenderer.invoke("gui:action", action),
	query: (query) => ipcRenderer.invoke("gui:query", query),
	acknowledge: (id) => ipcRenderer.send("gui:ack", id),
	subscribe(listener) {
		const handle = (_event: Electron.IpcRendererEvent, value: GuiDelivery) => listener(value);
		ipcRenderer.on("gui:event", handle);
		ipcRenderer.send("gui:subscribe");
		return () => ipcRenderer.removeListener("gui:event", handle);
	},
	close() {
		ipcRenderer.send("gui:unsubscribe");
	},
	chooseDirectory: () => ipcRenderer.invoke("gui:directory"),
	openExternal: (url) => ipcRenderer.invoke("gui:external", url),
};
contextBridge.exposeInMainWorld("opi", bridge);
