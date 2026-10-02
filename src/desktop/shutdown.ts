import { app, dialog, type BrowserWindow, type Event } from "electron";
import type { BackendClient } from "./backend-client.ts";
import type { DesktopDiagnostics } from "./diagnostics.ts";

export function installDesktopShutdown(window: BrowserWindow, client: BackendClient, diagnostics: DesktopDiagnostics): void {
	let approved = false;
	let pending = false;
	let finished = false;

	async function close(): Promise<void> {
		if (!approved) {
			const active = await client.activeSessions();
			if (active > 0) {
				const { response } = await dialog.showMessageBox(window, {
					type: "warning",
					message: "仍有会话正在进行，确定关闭？",
					detail: `关闭将停止全部 ${active} 个进行中的会话，并退出 Desktop。`,
					buttons: ["取消", "停止所有会话并退出"],
					defaultId: 0,
					cancelId: 0,
					noLink: true,
				});
				if (response !== 1) return;
			}
			approved = true;
		}
		if (client.stop()) return;
		await diagnostics.close();
		finished = true;
		app.quit();
	}
	function requestClose(event: Event): void {
		if (finished) return;
		event.preventDefault();
		if (pending) return;
		pending = true;
		void close().catch((error: unknown) => {
			dialog.showErrorBox("退出失败", error instanceof Error ? error.message : String(error));
		}).finally(() => { pending = false; });
	}
	window.on("close", requestClose);
	app.on("before-quit", requestClose);
	// 后端已停止时，不再让未保存设置的 beforeunload 留下失效窗口。
	window.webContents.on("will-prevent-unload", (event) => { if (finished) event.preventDefault(); });
}
