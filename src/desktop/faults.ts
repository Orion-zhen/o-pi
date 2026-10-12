import { app, clipboard, dialog, type BrowserWindow } from "electron";
import { release } from "node:os";
import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import { diagnosticText, type GuiDiagnostic } from "../gui/diagnostics.ts";
import { guiDiagnosticSchema } from "../gui/diagnostic-schema.ts";
import type { DesktopDiagnostics } from "./diagnostics.ts";

export function installDesktopFaults(window: BrowserWindow, diagnostics: DesktopDiagnostics) {
	const environment = `opi-desktop ${app.getVersion()} / ${process.platform} ${release()} ${process.arch} / Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`;
	window.webContents.on("render-process-gone", (_event, details) => {
		const value: GuiDiagnostic = {
			id: randomUUID(), at: Date.now(), kind: "renderer-exit", scope: "application",
			message: `reason: ${details.reason}, exitCode: ${details.exitCode}`, stack: "", componentStack: "",
			sessionId: null, lastAction: null, lastEvent: null, deliveryId: null, running: null, userAgent: "",
		};
		void diagnostics.error(value, environment).then(async (receipt) => {
			if (window.isDestroyed()) return;
			const text = `${diagnosticText(value)}\n${receipt.saved ? "已写入" : "写入失败"}: ${receipt.file}\nrun: ${receipt.run}\n${environment}`;
			const { response } = await dialog.showMessageBox({
				type: "error", message: "界面渲染进程已退出",
				detail: `后台任务可能仍在运行，请勿重复发送。\n${text}`,
				buttons: ["关闭提示", "复制诊断信息"], defaultId: 0, cancelId: 0, noLink: true,
			});
			if (response === 1) clipboard.writeText(text);
		}).catch((error: unknown) => { console.error("Renderer failure diagnostics:", error); });
	});
	return (value: unknown) => {
		if (!Check(guiDiagnosticSchema, value)) throw new Error("无效界面诊断");
		return diagnostics.error(value, environment);
	};
}
