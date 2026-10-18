import { act, createElement, useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RegionBoundary } from "../../src/gui/ui/runtime/region-boundary.tsx";
import { diagnosticContext, installGlobalDiagnostics, reportDiagnostic } from "../../src/gui/ui/runtime/diagnostics.ts";
import type { DesktopBridge } from "../../src/gui/contract.ts";
import { connectGui } from "../../src/gui/ui/runtime/connection.ts";
import type { GuiDelivery } from "../../src/gui/sync.ts";

let root: Root;
const report = vi.fn<DesktopBridge["reportDiagnostic"]>();
const copy = vi.fn<(text: string) => Promise<void>>();
const send = vi.fn();

beforeEach(() => {
	const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
	vi.stubGlobal("window", window);
	vi.stubGlobal("document", document);
	vi.stubGlobal("navigator", { userAgent: "diagnostics-test", clipboard: { writeText: copy } });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	Object.defineProperty(window, "opi", { configurable: true, value: { reportDiagnostic: report, send } });
	vi.spyOn(console, "error").mockImplementation(() => {});
	report.mockResolvedValue({ file: "/logs/gui-timing.jsonl", run: "run-1", environment: "Windows / Electron test", saved: true });
	copy.mockResolvedValue(undefined);
	diagnosticContext({ sessionId: "session-1", lastAction: "prompt", lastEvent: "patch", deliveryId: 7, running: true });
	const element = document.getElementById("root");
	if (!element) throw new Error("缺少测试根节点");
	root = createRoot(element, { onUncaughtError: (error, info) => { reportDiagnostic("react-root", "application", error, info.componentStack); } });
	installGlobalDiagnostics();
});
afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

function Message({ failed, effect = false }: { failed: boolean; effect?: boolean }) {
	useLayoutEffect(() => { if (failed && effect) throw new Error("处理动画初始化失败"); }, [failed, effect]);
	if (failed && !effect) throw new Error("消息投影失败");
	return createElement("p", null, "正常消息");
}
function Chat({ failed }: { failed: boolean }) {
	return createElement("main", null,
		createElement("aside", null, "会话导航"),
		createElement(RegionBoundary, { scope: "messages", children: createElement(Message, { failed, effect: true }) }),
		createElement("textarea", { defaultValue: "未发送草稿" }),
	);
}

it("消息动画初始化失败只卸载消息区域，保留草稿且不自动重试", async () => {
	await act(async () => root.render(createElement(Chat, { failed: false })));
	const editor = document.querySelector("textarea");
	if (!editor) throw new Error("缺少草稿输入框");
	editor.value = "编辑后的草稿";
	await act(async () => root.render(createElement(Chat, { failed: true })));
	expect(document.querySelector("aside")?.textContent).toBe("会话导航");
	expect(document.querySelector("textarea")).toBe(editor);
	expect(editor.value).toBe("编辑后的草稿");
	expect(document.querySelector(".diagnostic-region")?.textContent).toContain("消息区显示失败");
	expect(report).toHaveBeenCalledWith(expect.objectContaining({ kind: "region", scope: "messages", lastAction: "prompt", deliveryId: 7, running: true, componentStack: expect.stringContaining("Message") }));
	await act(async () => root.render(createElement(Chat, { failed: false })));
	expect(document.querySelector(".diagnostic-region")).not.toBeNull();
	expect(report).toHaveBeenCalledOnce();
});

it("根组件卸载后独立面板保留摘要，折叠详情并可复制异常和日志回执", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
	flushSync(() => root.render(createElement(Message, { failed: true })));
	await Promise.resolve();
	expect(document.getElementById("root")?.childElementCount).toBe(0);
	const panel = document.getElementById("gui-diagnostics");
	expect(panel?.parentElement).toBe(document.body);
	expect(panel?.dataset.fatal).toBe("true");
	expect(panel?.textContent).toContain("整页渲染失败");
	expect(panel?.querySelector(".diagnostic-message")?.textContent).toBe("Error: 消息投影失败");
	expect(panel?.querySelector("details")?.hasAttribute("open")).toBe(false);
	expect(panel?.querySelector("pre")?.textContent).toContain('"deliveryId": 7');
	panel?.querySelector("button")?.click();
	await Promise.resolve();
	expect(copy).toHaveBeenCalledWith(expect.stringContaining("run: run-1"));
	expect(copy).toHaveBeenCalledWith(expect.stringContaining("/logs/gui-timing.jsonl"));
	expect(copy).toHaveBeenCalledWith(expect.stringContaining("消息投影失败"));
});

it("连续异常只保留最近十条，新异常和日志回执不改变已展开详情", async () => {
	reportDiagnostic("script", "application", new Error("最早异常"));
	for (let index = 0; index < 9; index++) reportDiagnostic("script", "application", new Error(`后续异常 ${index}`));
	const detail = document.querySelector("#gui-diagnostics article:last-child details");
	detail?.setAttribute("open", "");
	reportDiagnostic("promise", "application", new Error("最新异常"));
	await Promise.resolve();
	expect(document.querySelectorAll("#gui-diagnostics details")).toHaveLength(10);
	expect(document.getElementById("gui-diagnostics")?.textContent).not.toContain("最早异常");
	expect(document.getElementById("gui-diagnostics")?.textContent).toContain("最新异常");
	expect(detail?.hasAttribute("open")).toBe(true);
	expect(document.querySelectorAll("#gui-diagnostics details[open]")).toHaveLength(1);
});

it("刷新会话列表不会覆盖诊断中的当前会话", async () => {
	let receive: ((delivery: GuiDelivery) => void) | undefined;
	if (!window.opi) throw new Error("缺少桌面桥接");
	Object.assign(window.opi, {
		subscribe: (listener: (delivery: GuiDelivery) => void) => { receive = listener; return () => {}; },
		acknowledge: vi.fn(), close: vi.fn(),
	});
	vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1; });
	const connection = connectGui(() => {});
	try {
		if (!receive) throw new Error("缺少连接订阅");
		receive({ kind: "frame", id: 8, events: [{ type: "selected", session: { id: "selected-session", cwd: "/workspace", path: null } }] });
		await Promise.resolve();
		await connection.send({ action: "sessions" }, null);
		reportDiagnostic("script", "application", new Error("刷新后的异常"));
		expect(report).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "selected-session", lastAction: "sessions", deliveryId: 8 }));
	} finally { connection.close(); }
});

it("脚本和异步异常分别分类，日志桥接失败仍保留原始异常", async () => {
	report.mockRejectedValue(new Error("IPC 不可用"));
	const error = new window.Event("error");
	Object.assign(error, { error: new Error("脚本出错"), message: "脚本出错" });
	window.dispatchEvent(error);
	const rejection = new window.Event("unhandledrejection");
	Object.assign(rejection, { reason: new Error("异步出错") });
	window.dispatchEvent(rejection);
	await Promise.resolve();
	expect(report.mock.calls.map(([value]) => value.kind)).toEqual(["script", "promise"]);
	expect(document.getElementById("gui-diagnostics")?.textContent).toContain("诊断日志写入失败: Error: IPC 不可用");
	expect(document.getElementById("gui-diagnostics")?.textContent).toContain("脚本出错");
	expect(document.getElementById("gui-diagnostics")?.dataset.fatal).toBeUndefined();
});

it("Web 无日志桥接时仍提供诊断，复制失败明确提示手动选择", async () => {
	Reflect.deleteProperty(window, "opi");
	copy.mockRejectedValue(new Error("权限被拒绝"));
	reportDiagnostic("script", "application", new Error("Web 异常"));
	const panel = document.getElementById("gui-diagnostics");
	expect(panel?.textContent).toContain("Web 端未保存到服务器");
	panel?.querySelector("button")?.click();
	await Promise.resolve();
	expect(panel?.textContent).toContain("复制失败，请展开详情手动选择");
});

it("全局拒绝值按纯文本显示并限长，不展开对象中的凭据或正文", () => {
	for (const reason of ['<img src=x onerror="bad()">', { apiKey: "SECRET", messages: ["PRIVATE_INPUT"] }, "x".repeat(5000)]) {
		const rejection = new window.Event("unhandledrejection");
		Object.assign(rejection, { reason });
		window.dispatchEvent(rejection);
	}
	expect(document.querySelector("#gui-diagnostics img")).toBeNull();
	expect(document.getElementById("gui-diagnostics")?.textContent).toContain('<img src=x onerror="bad()">');
	expect(JSON.stringify(report.mock.calls)).not.toMatch(/SECRET|PRIVATE_INPUT/);
	expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ message: "x".repeat(4096) }));
});
