import { EventEmitter } from "node:events";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { app, BrowserWindow, dialog, utilityProcess } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendClient } from "../../src/desktop/backend-client.ts";
import type { BackendCommand, BackendMessage } from "../../src/desktop/backend-contract.ts";
import { DesktopDiagnostics } from "../../src/desktop/diagnostics.ts";
import { installDesktopShutdown } from "../../src/desktop/shutdown.ts";
import { useTempDir } from "../helpers/lifecycle.ts";

vi.mock("electron", async () => {
	const { EventEmitter } = await import("node:events");
	return {
		app: Object.assign(new EventEmitter(), { quit: vi.fn() }),
		BrowserWindow: class extends EventEmitter { webContents = new EventEmitter(); },
		dialog: { showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })), showErrorBox: vi.fn() },
		utilityProcess: { fork: vi.fn(() => Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() })) },
	};
});

const temp = useTempDir("opi-desktop-shutdown-");
beforeEach(() => { vi.clearAllMocks(); app.removeAllListeners(); });
afterEach(() => vi.useRealTimers());

function setup(debug = false) {
	const child = utilityProcess.fork("backend.mjs");
	const commands: BackendCommand[] = [];
	vi.mocked(child.postMessage).mockImplementation((message: BackendCommand) => { commands.push(message); });
	const diagnostics = new DesktopDiagnostics(path.join(temp.path, "gui-timing.jsonl"), debug);
	const client = new BackendClient(child, diagnostics);
	const window = new BrowserWindow();
	installDesktopShutdown(window, client, diagnostics);
	function respond(value: number): void {
		const request = commands.at(-1);
		if (!request || request.kind !== "activeSessions") throw new Error("缺少活动会话查询");
		child.emit("message", { kind: "result", id: request.id, value } satisfies BackendMessage);
	}
	return { child, client, window, diagnostics, respond };
}

function close(target: EventEmitter, event = "close") {
	const value = { preventDefault: vi.fn() };
	target.emit(event, value);
	return value;
}

describe("Desktop 退出", () => {
	it("取消后保持运行，再次确认才停止后端并退出", async () => {
		const { window, respond, child } = setup();
		expect(close(window).preventDefault).toHaveBeenCalledOnce();
		respond(3);
		await setImmediate();
		expect(dialog.showMessageBox).toHaveBeenCalledOnce();
		expect(child.postMessage).not.toHaveBeenCalledWith({ kind: "dispose" });
		expect(app.quit).not.toHaveBeenCalled();

		vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false });
		close(window);
		respond(3);
		await setImmediate();
		expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
		expect(child.postMessage).toHaveBeenCalledWith({ kind: "dispose" });
		child.emit("exit", 0);
		await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
	});

	it("合并退出请求，等待后端与日志关闭，随后允许退出而不再被草稿阻拦", async () => {
		const { window, respond, child, diagnostics } = setup();
		const writing = Promise.withResolvers<void>();
		void diagnostics.manageFiles(() => writing.promise);
		close(window);
		close(app, "before-quit");
		respond(0);
		await setImmediate();
		close(window);
		expect(app.quit).not.toHaveBeenCalled();
		child.emit("exit", 0);
		await setImmediate();
		expect(app.quit).not.toHaveBeenCalled();
		writing.resolve();
		await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
		expect(close(app, "before-quit").preventDefault).not.toHaveBeenCalled();
		expect(close(window.webContents, "will-prevent-unload").preventDefault).toHaveBeenCalledOnce();
	});

	it("停止超时强制终止，等待实际退出并记录未完成请求失败", async () => {
		vi.useFakeTimers();
		const { child, client, diagnostics } = setup(true);
		const request = client.request({ kind: "action", value: { sessionId: null, value: { action: "workspace", path: temp.path } } });
		const failed = expect(request).rejects.toThrow("后端已退出");
		const stopping = client.stop();
		let stopped = false;
		void stopping.then(() => { stopped = true; });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(child.kill).toHaveBeenCalledOnce();
		expect(stopped).toBe(false);
		child.emit("exit", 1);
		await stopping;
		await failed;
		await diagnostics.close();
		const settled = (await readFile(diagnostics.file, "utf8")).split("\n").filter((line) => line.includes('"phase":"request_settled"'));
		expect(settled).toHaveLength(1);
		expect(settled[0]).toContain('"failed":true');
		expect(vi.getTimerCount()).toBe(0);
	});
});
