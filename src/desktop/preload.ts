import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, GuiEvent } from "../gui/contract.ts";

const bridge: DesktopBridge = {
	send: (action) => ipcRenderer.invoke("gui:action", action),
	subscribe(listener) {
		const handle = (_event: Electron.IpcRendererEvent, value: GuiEvent) => listener(value);
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
