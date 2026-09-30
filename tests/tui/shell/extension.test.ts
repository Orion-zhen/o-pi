import { writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerExtension } from "../../helpers/extension.ts";
import { deferred } from "../../helpers/async.ts";
import { preserveEnv, setTestHome, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("opi-tui-session-");
preserveEnv("HOME", "USERPROFILE", "PI_TUI_CONFIG");
const cleanups: (() => Promise<unknown>)[] = [];
const math = {
	installMathMarkdownRenderer: vi.fn(),
	supportsDisplayMathImages: () => true,
	warmDisplayMathRenderer: vi.fn(async () => {}),
};

beforeEach(() => {
	setTestHome(temp.path);
	delete process.env.PI_TUI_CONFIG;
	vi.resetModules();
	vi.resetAllMocks();
	vi.doMock("../../../src/tui/chat/math/markdown.ts", () => math);
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.doUnmock("../../../src/tui/chat/math/markdown.ts");
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function start(mode: "tui" | "rpc" | "print" = "tui") {
	const { default: extension } = await import("../../../src/tui/shell/extension.ts");
	let name = "initial";
	const { handlers } = registerExtension(extension, {
		getThinkingLevel: () => "off", getSessionName: () => name,
		getAllTools: () => [], getActiveTools: () => [], getCommands: () => [],
	});
	const ui = {
		theme: { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text },
		notify: vi.fn(), setTitle: vi.fn(), setStatus: vi.fn(), setWorkingIndicator: vi.fn(),
		setHeader: vi.fn<ExtensionUIContext["setHeader"]>(),
		setFooter: vi.fn<ExtensionUIContext["setFooter"]>(),
		setEditorComponent: vi.fn<ExtensionUIContext["setEditorComponent"]>(),
		getEditorComponent: (): ReturnType<ExtensionUIContext["getEditorComponent"]> => ui.setEditorComponent.mock.calls.at(-1)?.[0],
	};
	const state = { idle: true, pending: false };
	const ctx = {
		cwd: temp.path, mode, ui, model: undefined,
		modelRegistry: { isUsingOAuth: () => false, getAvailable: () => [] },
		sessionManager: SessionManager.inMemory(temp.path), getContextUsage: () => undefined,
		isIdle: () => state.idle, hasPendingMessages: () => state.pending,
	};
	const emit = async (event: string, data = {}) => handlers.get(event)?.(data, ctx);
	cleanups.push(() => emit("session_shutdown"));
	await emit("session_start", { reason: "startup" });
	return { ui, emit, state, rename(value: string) { name = value; } };
}

it("标题、运行和审批状态随会话更新，退出恢复界面", async () => {
	const { ui, emit, rename } = await start();
	rename("检查变更");
	await emit("session_info_changed");
	expect(ui.setTitle.mock.lastCall?.[0]).toContain("检查变更");
	await emit("ui_prompt_start");
	expect(ui.setStatus.mock.lastCall?.[1]).toContain("ready");
	await emit("agent_start");
	expect(ui.setStatus.mock.lastCall?.[1]).toContain("running");
	await emit("ui_prompt_start");
	expect(ui.setStatus.mock.lastCall?.[1]).toContain("waiting");
	await emit("ui_prompt_end");
	expect(ui.setStatus.mock.lastCall?.[1]).toContain("running");
	await emit("agent_settled");
	expect(ui.setStatus.mock.lastCall?.[1]).toContain("ready");
	await emit("session_shutdown");
	expect(ui.setHeader.mock.lastCall).toEqual([undefined]);
	expect(ui.setFooter.mock.lastCall).toEqual([undefined]);
	expect(ui.getEditorComponent()).toBeUndefined();
	expect(ui.setStatus.mock.lastCall?.[1]).toBeUndefined();
});

it.each(["rpc", "print"] as const)("%s 不安装终端界面", async (mode) => {
	const { ui } = await start(mode);
	expect(ui.getEditorComponent()).toBeUndefined();
	expect(ui.setTitle.mock.calls).toEqual([]);
});

it("配置错误可修复，停用增强后不再安装编辑器", async () => {
	const file = path.join(temp.path, "tui.jsonc");
	process.env.PI_TUI_CONFIG = file;
	await writeFile(file, '{"enabled":"invalid"}');
	await expect(start()).rejects.toMatchObject({ name: "TuiConfigError" });
	await writeFile(file, '{"enabled":true,"math":{"enabled":false}}');
	const { ui, emit } = await start();
	expect(ui.getEditorComponent()).toBeTypeOf("function");
	await writeFile(file, '{"enabled":false}');
	await emit("session_start", { reason: "reload" });
	expect(ui.getEditorComponent()).toBeUndefined();
});

it.each(["running", "queued", "closed"])("%s 时不初始化数学渲染，恢复空闲后可继续", async (phase) => {
	vi.useFakeTimers();
	const { emit, state } = await start();
	state.idle = phase !== "running";
	state.pending = phase === "queued";
	await emit(phase === "closed" ? "session_shutdown" : "agent_start");
	await vi.advanceTimersByTimeAsync(1000);
	expect(math.installMathMarkdownRenderer.mock.calls).toEqual([]);
	if (phase === "closed") return;
	state.idle = true; state.pending = false;
	await emit("agent_settled");
	await vi.advanceTimersByTimeAsync(1000);
	expect(math.installMathMarkdownRenderer).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
	await emit("session_shutdown");
	expect(math.installMathMarkdownRenderer).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
});

it.each(["reload", "running", "shutdown"])("数学初始化在 %s 后完成，不覆盖新会话或运行状态", async (phase) => {
	vi.useFakeTimers();
	const pending = deferred<void>();
	math.warmDisplayMathRenderer.mockImplementation(() => pending.promise);
	const { emit, state, ui } = await start();
	await vi.advanceTimersByTimeAsync(1000);
	if (phase === "reload") await emit("session_start", { reason: "reload" });
	else {
		state.idle = false;
		await emit(phase === "running" ? "agent_start" : "session_shutdown");
	}
	const status = ui.setStatus.mock.lastCall;
	pending.resolve();
	await vi.advanceTimersByTimeAsync(0);
	expect(ui.setStatus.mock.lastCall).toEqual(status);
});

it("数学后端失败不影响会话，重载不重复警告", async () => {
	vi.useFakeTimers();
	math.warmDisplayMathRenderer.mockRejectedValue(new Error("renderer unavailable"));
	const { emit, ui } = await start();
	await vi.advanceTimersByTimeAsync(1000);
	expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("renderer unavailable"), "warning");
	await emit("agent_start");
	expect(ui.setStatus.mock.lastCall?.[1]).toContain("running");
	await emit("session_start", { reason: "reload" });
	await vi.advanceTimersByTimeAsync(1000);
	expect(ui.notify.mock.calls).toHaveLength(1);
});
