import { readFile } from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, clipboard, dialog } from "electron";
import { describe, expect, it, vi } from "vitest";
import { installDesktopFaults } from "../../src/desktop/faults.ts";
import { DesktopDiagnostics } from "../../src/desktop/diagnostics.ts";
import type { GuiDiagnostic } from "../../src/gui/diagnostics.ts";
import { useTempDir } from "../helpers/lifecycle.ts";

vi.mock("electron", async () => {
	const { EventEmitter } = await import("node:events");
	return {
		app: { getVersion: () => "test-version" },
		clipboard: { writeText: vi.fn() },
		dialog: { showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: false })) },
		BrowserWindow: class { webContents = new EventEmitter(); isDestroyed() { return false; } },
	};
});
const temp = useTempDir("opi-desktop-faults-");
const fault: GuiDiagnostic = {
	id: "report-1", at: 100, kind: "region", scope: "messages", message: "动画异常", stack: "Error: 动画异常\n at reply.js:1:2", componentStack: "\n at ReplyBreathing",
	sessionId: "session-1", lastAction: "prompt", lastEvent: "patch", deliveryId: 2, running: true, userAgent: "test-UA",
};

describe("桌面异常诊断", () => {
	it("校验渲染器报告并持久化，返回可与时间线关联的编号和日志位置", async () => {
		const log = new DesktopDiagnostics(path.join(temp.path, "gui-timing.jsonl"));
		const receive = installDesktopFaults(new BrowserWindow(), log);
		const receipt = await receive(fault);
		expect(receipt.saved).toBe(true);
		expect(receipt.file).toBe(log.file);
		expect(receipt.environment).toContain("test-version");
		await log.close();
		const records: Record<string, unknown>[] = (await readFile(log.file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(records.find((value) => value.phase === "gui_error")).toMatchObject({ ...fault, run: receipt.run, generation: 0, environment: receipt.environment });
	});
	it("拒绝过长或夹带额外载荷的报告，不把整个对象写入日志", async () => {
		const log = new DesktopDiagnostics(path.join(temp.path, "gui-timing.jsonl"));
		const receive = installDesktopFaults(new BrowserWindow(), log);
		for (const value of [null, { ...fault, kind: "unknown" }, { ...fault, stack: "x".repeat(16385) }, { ...fault, payload: "PRIVATE_INPUT" }])
			expect(() => receive(value)).toThrow("无效界面诊断");
		await log.close();
		expect(await readFile(log.file, "utf8")).not.toContain("gui_error");
	});
	it("渲染进程退出由主进程显示原因和日志位置，复制不重启窗口或后端", async () => {
		vi.mocked(dialog.showMessageBox).mockClear();
		vi.mocked(clipboard.writeText).mockClear();
		const log = new DesktopDiagnostics(path.join(temp.path, "gui-timing.jsonl"));
		const window = new BrowserWindow();
		installDesktopFaults(window, log);
		window.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 9 });
		await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledOnce());
		expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining("reason: crashed, exitCode: 9"), buttons: ["关闭提示", "复制诊断信息"] }));
		expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining(log.file));
		await log.close();
		expect(await readFile(log.file, "utf8")).toContain('"kind":"renderer-exit"');
	});
	it("日志写入失败如实返回，不声称诊断已经保存", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const log = new DesktopDiagnostics(temp.path);
			const receipt = await log.error(fault, "test-environment");
			expect(receipt.saved).toBe(false);
			await log.close();
		} finally { error.mockRestore(); }
	});
});
