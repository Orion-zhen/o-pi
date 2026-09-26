import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../gui/contract.ts";
import type { GuiDelivery } from "../gui/sync.ts";

const bridge: DesktopBridge = {
	send: (value, sessionId) => ipcRenderer.invoke("gui:action", { value, sessionId }, Date.now()),
	query: (value, sessionId) => ipcRenderer.invoke("gui:query", { value, sessionId }),
	acknowledge: (id) => ipcRenderer.send("gui:ack", id, Date.now()),
	subscribe(listener) {
		const handle = (_event: Electron.IpcRendererEvent, value: GuiDelivery, traced: boolean) => {
			if (traced) ipcRenderer.send("gui:received", value.id, Date.now());
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
};
contextBridge.exposeInMainWorld("opi", bridge);
