import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import {
	ProcessTerminal,
	TuiAltScreen,
	TuiMainScreen,
	type Component,
	type EditorComponent,
	type EditorTheme,
	type TUI,
	type TuiMode,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import tuiExtension, { createTuiExtension } from "../../agent/extensions/tui.js";
import { getAssistantPerformance } from "../../src/tui/message-performance.js";
import { createTuiRuntime, type MathMarkdownModule } from "../../src/tui/runtime.js";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.js";

type Handler = (event: unknown, ctx: ExtensionContextStub) => Promise<void> | void;
type TuiStub = { mode: TuiMode; requestRender(): void };
type FooterFactory = (tui: TuiStub, theme: ThemeStub, footerData: FooterDataStub) => Component & { dispose(): void };
type HeaderFactory = (tui: TuiStub, theme: ThemeStub) => Component;
type EditorFactoryStub = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

interface ThemeStub {
	fg(_name: string, text: string): string;
	bg(_name: string, text: string): string;
}

interface FooterDataStub {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(callback: () => void): () => void;
}

interface SessionEntryStub {
	type: string;
	message?: { role: string };
}

interface ExtensionContextStub {
	cwd: string;
	mode: "tui" | "rpc" | "json" | "print";
	ui: {
		theme: ThemeStub;
		notify(message: string, type?: string): void;
		setTitle(title: string): void;
		setStatus(key: string, text: string | undefined): void;
		setFooter(factory: FooterFactory | undefined): void;
		setHeader(factory: HeaderFactory | undefined): void;
		setWorkingIndicator(options?: unknown): void;
		setEditorComponent(factory: EditorFactoryStub | undefined): void;
		getEditorComponent(): EditorFactoryStub | undefined;
	};
	getContextUsage(): undefined;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	model: ModelStub | undefined;
	modelRegistry: { isUsingOAuth(model: ModelStub): boolean; getAvailable(): ModelStub[] };
	sessionManager: { getEntries(): SessionEntryStub[]; buildContextEntries(): never[]; getSessionId(): string };
}

interface ModelStub {
	provider: string;
	id: string;
	reasoning?: boolean;
}

let dir: string;
const temp = useTempDir("o-pi-tui-extension-");
preserveEnv("PI_TUI_CONFIG", "HOME", "USERPROFILE");

beforeEach(() => {
	dir = temp.path;
	setTestHome(dir);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("tui extension", () => {
	it("聊天 footer 在渲染时读取当前工具启用状态", async () => {
		const file = path.join(dir, "tui.jsonc");
		await writeFile(file, '{ "home": { "enabled": false } }');
		process.env["PI_TUI_CONFIG"] = file;
		let activeTools = ["read"];
		const { calls, ctx } = await startTui({}, { getActiveTools: () => activeTools });
		const component = calls.footer.at(-1)?.({ mode: "regular", requestRender() {} }, ctx.ui.theme, createFooterData());

		expect(component?.render(80).join("\n")).toMatch(/\b1\/3\b/u);
		activeTools = ["unknown", "bash", "read"];
		expect(component?.render(80).join("\n")).toMatch(/\b2\/3\b/u);
	});

	it("空会话按 TUI 模式选择旧版 regular banner 或 fullscreen Home", async () => {
		const { handlers, calls, ctx } = await startTui({ mode: "tui" });

		expect(calls.footer.at(-1)).toBeTypeOf("function");
		expect(calls.editor.at(-1)).toBeTypeOf("function");
		expect(calls.status.at(-1)).toMatchObject({ key: "o-pi:tui", text: expect.any(String) });
		expect(calls.working.length).toBeGreaterThan(0);
		const homeHeader = calls.header.at(-1);
		const regularHeader = homeHeader?.({ mode: "regular", requestRender() {} }, ctx.ui.theme);
		const fullscreenHeader = homeHeader?.({ mode: "fullscreen", requestRender() {} }, ctx.ui.theme);
		const regularFooter = calls.footer.at(-1)?.({ mode: "regular", requestRender() {} }, ctx.ui.theme, createFooterData());
		const fullscreenFooter = calls.footer.at(-1)?.({ mode: "fullscreen", requestRender() {} }, ctx.ui.theme, createFooterData());
		expect(homeHeader).toBeTypeOf("function");
		expect(regularHeader?.render(120).length).toBeGreaterThan(0);
		expect(fullscreenHeader?.render(120)).toEqual([]);
		expect(regularFooter?.render(80).join("\n")).toMatch(/\b1\/3\b/u);
		expect(fullscreenFooter?.render(80).length).toBeGreaterThan(0);
		await handlers.get("agent_start")?.({}, ctx);

		expect(calls.header.at(-1)).toBeUndefined();
		expect(calls.header.at(-1)).not.toBe(homeHeader);
		expect(calls.footer.at(-1)).toBeTypeOf("function");
		expect(calls.status.at(-1)).toMatchObject({ key: "o-pi:tui", text: expect.any(String) });
	});

	it("官方 footer provider 的分支由启动界面与聊天 chrome 共享，并在组件释放时取消订阅", async () => {
		const file = path.join(dir, "tui.jsonc");
		await writeFile(file, '{ "chrome": { "header": true }, "home": { "motion": "off" } }');
		process.env["PI_TUI_CONFIG"] = file;
		const { handlers, calls, ctx } = await startTui({ mode: "tui" });
		const provider = createFooterDataController("main");
		const homeRender = vi.fn();
		const startupFooterFactory = calls.footer.at(-1);
		const startupHeaderFactory = calls.header.at(-1);
		const editorFactory = calls.editor.at(-1);
		if (startupFooterFactory === undefined || startupHeaderFactory === undefined || editorFactory === undefined) {
			throw new Error("startup components were not installed");
		}
		const homeFooter = startupFooterFactory(
			{ mode: "fullscreen", requestRender: homeRender },
			ctx.ui.theme,
			provider.data,
		);
		const banner = startupHeaderFactory({ mode: "regular", requestRender() {} }, ctx.ui.theme);
		const editor = editorFactory(
			new TuiAltScreen(new ProcessTerminal()),
			plainEditorTheme(),
			KeybindingsManager.create(dir),
		);

		expect(banner.render(120).join("\n")).toContain("main");
		expect(editor.render(100).join("\n")).toContain("main");
		expect(calls.title.at(-1)).toContain("main");
		expect(provider.subscriberCount()).toBe(1);

		provider.setBranch("feature/provider");
		expect(homeRender).toHaveBeenCalledOnce();
		expect(banner.render(120).join("\n")).toContain("feature/provider");
		expect(editor.render(100).join("\n")).toContain("feature/provider");
		expect(calls.title.at(-1)).toContain("feature/provider");

		homeFooter.dispose();
		expect(provider.subscriberCount()).toBe(0);
		await handlers.get("agent_start")?.({}, ctx);
		const chatRender = vi.fn();
		const chatFooter = calls.footer.at(-1)?.(
			{ mode: "regular", requestRender: chatRender },
			ctx.ui.theme,
			provider.data,
		);
		const chatHeader = calls.header.at(-1)?.({ mode: "regular", requestRender() {} }, ctx.ui.theme);
		if (chatFooter === undefined || chatHeader === undefined) throw new Error("chat chrome was not installed");
		expect(chatFooter.render(120).join("\n")).toContain("feature/provider");
		expect(chatHeader.render(120).join("\n")).toContain("feature/provider");
		expect(provider.subscriberCount()).toBe(1);

		provider.setBranch("release");
		expect(chatRender).toHaveBeenCalledOnce();
		expect(chatFooter.render(120).join("\n")).toContain("release");
		const releaseHeader = calls.header.at(-1)?.({ mode: "regular", requestRender() {} }, ctx.ui.theme);
		expect(releaseHeader?.render(120).join("\n")).toContain("release");
		chatFooter.dispose();
		expect(provider.subscriberCount()).toBe(0);
		provider.setBranch("ignored-after-dispose");
		expect(chatRender).toHaveBeenCalledOnce();
		await handlers.get("session_shutdown")?.({}, ctx);

		await handlers.get("session_start")?.({}, ctx);
		const restartedBanner = calls.header.at(-1)?.({ mode: "regular", requestRender() {} }, ctx.ui.theme);
		expect(restartedBanner?.render(120).join("\n")).not.toContain("ignored-after-dispose");
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	it.each(["发送普通消息", "/skill:development 实现需求"])(
		"首页回车提交 %s 后在 agent_start 前立即进入会话界面",
		async (text) => {
			const { handlers, calls, ctx } = await startTui({ mode: "tui" });
			const editorFactory = calls.editor.at(-1);
			if (editorFactory === undefined) throw new Error("editor factory was not installed");
			const editor = editorFactory(
				new TuiMainScreen(new ProcessTerminal()),
				plainEditorTheme(),
				KeybindingsManager.create(dir),
			);
			const submit = vi.fn();
			editor.onSubmit = submit;
			editor.setText(text);

			editor.handleInput("\r");

			expect(submit).toHaveBeenCalledWith(text);
			expect(calls.header.at(-1)).toBeUndefined();
			const footer = calls.footer.at(-1)?.({ mode: "regular", requestRender() {} }, ctx.ui.theme, createFooterData());
			expect(footer?.render(80).join("\n")).toContain("tools 1/3");
			expect(footer?.render(80).join("\n")).not.toContain("O Pi v");
			await handlers.get("session_shutdown")?.({}, ctx);
		},
	);

	it("恢复已有会话时直接进入聊天，不显示 Home", async () => {
		const { calls, ctx } = await startTui({
			mode: "tui",
			entries: [{ type: "message", message: { role: "user" } }],
		});

		expect(calls.header.at(-1)).toBeUndefined();
		const footer = calls.footer.at(-1)?.({ mode: "regular", requestRender() {} }, ctx.ui.theme, createFooterData());
		expect(footer?.render(80).join("\n")).toContain("tools 1/3");
		expect(footer?.render(80).join("\n")).not.toContain("O Pi v");
	});

	it("agent_start 按配置将 Home header 替换为普通 header", async () => {
		const file = path.join(dir, "tui.jsonc");
		await writeFile(file, '{ "chrome": { "header": true } }');
		process.env["PI_TUI_CONFIG"] = file;
		const { handlers, calls, ctx } = await startTui({ mode: "tui" });
		const homeHeader = calls.header.at(-1);
		await handlers.get("agent_start")?.({}, ctx);

		expect(calls.header.at(-1)).toBeTypeOf("function");
		expect(calls.header.at(-1)).not.toBe(homeHeader);
	});

	it("首轮对话前 model_select 刷新 startup chrome 和 title", async () => {
		const { handlers, calls, ctx } = await startTui({ mode: "tui" });
		const footerCount = calls.footer.length;
		ctx.model = { provider: "openai", id: "gpt-5.2", reasoning: true };
		await handlers.get("model_select")?.({ type: "model_select", model: ctx.model, previousModel: undefined, source: "set" }, ctx);

		const header = calls.header.at(-1)?.({ mode: "regular", requestRender() {} }, ctx.ui.theme);
		const footer = calls.footer.at(-1)?.({ mode: "regular", requestRender() {} }, ctx.ui.theme, createFooterData());
		expect(calls.footer.length).toBeGreaterThan(footerCount);
		expect(header?.render(120).join("\n")).toContain("gpt-5.2");
		expect(footer?.render(120).join("\n")).toContain("tools 1/3");
		expect(calls.title.at(-1)).toContain("gpt-5.2");
		expect(calls.status.at(-1)).toMatchObject({ key: "o-pi:tui", text: expect.any(String) });
	});

	it("agent_settled 仅在 TUI 模式通知用户", async () => {
		const handlers = new Map<string, Handler>();
		const notifyUser = vi.fn(async () => {});
		createTuiRuntime(createPi(handlers) as unknown as ExtensionAPI, undefined, notifyUser);

		await handlers.get("agent_settled")?.({}, createContext(createUiCalls(), { mode: "tui" }));
		await handlers.get("agent_settled")?.({}, createContext(createUiCalls(), { mode: "rpc" }));

		expect(notifyUser).toHaveBeenCalledOnce();
	});

	it("Agent 空闲时打开扩展 UI 不改变 ready 状态，也不发送系统通知", async () => {
		const notifyUser = vi.fn(async () => {});
		const { handlers, calls, ctx, runtime } = await startRuntime({ notifyUser });
		const statusCount = calls.status.length;

		await handlers.get("ui_prompt_start")?.({ type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" }, ctx);
		await handlers.get("ui_prompt_end")?.({ type: "ui_prompt_end", reason: "ui_prompt", kind: "custom" }, ctx);

		expect(calls.status).toHaveLength(statusCount);
		expect(calls.status.at(-1)?.text).toContain("ready");
		expect(notifyUser).not.toHaveBeenCalled();
		await runtime.dispose(ctx as unknown as Parameters<typeof runtime.dispose>[0]);
	});

	it("agent run 在 turn_end 刷新快照但只在 agent 生命周期边界切换全局状态", async () => {
		vi.useFakeTimers();
		const notifyUser = vi.fn(async () => {});
		const { handlers, calls, ctx, runtime } = await startRuntime({ notifyUser });

		await handlers.get("agent_start")?.({}, ctx);
		expect(calls.status.at(-1)?.text).toContain("running");
		expect(handlers.has("turn_start")).toBe(false);
		expect(handlers.has("turn_end")).toBe(true);
		expect(handlers.has("agent_end")).toBe(false);

		await handlers.get("agent_settled")?.({}, ctx);
		expect(calls.status.at(-1)?.text).toContain("ready");
		expect(notifyUser).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(1);
		await runtime.dispose(ctx as unknown as Parameters<typeof runtime.dispose>[0]);
	});

	it("系统通知失败不影响 waiting 和 ready 状态", async () => {
		const { handlers, calls, ctx, runtime } = await startRuntime({
			notifyUser: async () => { throw new Error("notification unavailable"); },
		});
		await handlers.get("agent_start")?.({}, ctx);

		await expect(handlers.get("ui_prompt_start")?.({}, ctx)).resolves.toBeUndefined();
		expect(calls.status.at(-1)?.text).toContain("waiting");
		await expect(handlers.get("agent_settled")?.({}, ctx)).resolves.toBeUndefined();
		expect(calls.status.at(-1)?.text).toContain("ready");
		await runtime.dispose(ctx as unknown as Parameters<typeof runtime.dispose>[0]);
	});

	it("provider 和消息事件接入模型性能跟踪", async () => {
		const { handlers, ctx } = await startRuntime();
		const message = performanceMessage();
		const now = vi.spyOn(performance, "now");

		now.mockReturnValue(0);
		await handlers.get("before_provider_headers")?.({}, ctx);
		await handlers.get("message_start")?.({ message }, ctx);
		now.mockReturnValue(100);
		await handlers.get("message_update")?.({
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: message },
		}, ctx);
		now.mockReturnValue(200);
		await handlers.get("message_update")?.({
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " world", partial: message },
		}, ctx);
		await handlers.get("message_end")?.({ message }, ctx);

		expect(getAssistantPerformance(message)).toMatchObject({ bodyTps: 20, ttftWithoutThinkingMs: 100 });
		now.mockRestore();
	});

	it("session_shutdown 清理 header/footer/status", async () => {
		const { handlers, calls, ctx } = await startTui({ mode: "tui" });
		await handlers.get("session_shutdown")?.({}, ctx);

		expect(calls.header.at(-1)).toBeUndefined();
		expect(calls.footer.at(-1)).toBeUndefined();
		expect(calls.editor.at(-1)).toBeUndefined();
		expect(calls.status.at(-1)).toEqual({ key: "o-pi:tui", text: undefined });
	});

	it.each(["rpc", "json", "print"] as const)("%s 模式只执行 mode gate，不激活 TUI runtime", async (mode) => {
		vi.useFakeTimers();
		const loadRuntime = vi.fn(async () => {
			throw new Error("TUI runtime must not load");
		});
		const { handlers, calls } = await startTui({ mode }, {}, createTuiExtension(undefined, loadRuntime));

		expect(loadRuntime).not.toHaveBeenCalled();
		expect([...handlers.keys()]).toEqual(["session_start"]);
		expect(calls.title).toEqual([]);
		expect(calls.status).toEqual([]);
		expect(calls.footer).toEqual([]);
		expect(calls.header).toEqual([]);
		expect(calls.working).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("重复加载同一 extension 不重复注册 native handler", async () => {
		const handlers = new Map<string, Handler>();
		const on = vi.fn((name: string, handler: Handler) => {
			handlers.set(name, handler);
		});
		const pi = { ...createPi(handlers), on };
		const loadRuntime = vi.fn(async () => ({
			createTuiRuntime: () => ({ startSession: vi.fn(async () => {}), dispose: vi.fn() }),
		}));
		const extension = createTuiExtension(undefined, loadRuntime);

		extension(pi as unknown as ExtensionAPI);
		const registrationsAfterFirstLoad = on.mock.calls.length;
		extension(pi as unknown as ExtensionAPI);

		expect(on).toHaveBeenCalledTimes(registrationsAfterFirstLoad);
		expect([...handlers.keys()]).toEqual(["session_start"]);
	});

	it("native runtime 只加载并创建一次，但为每个 session_start 重置状态", async () => {
		const startSession = vi.fn(async () => {});
		const dispose = vi.fn();
		const createRuntime = vi.fn(() => ({ startSession, dispose }));
		const loadRuntime = vi.fn(async () => ({ createTuiRuntime: createRuntime }));
		const { handlers, ctx } = await startTui({ mode: "tui" }, {}, createTuiExtension(undefined, loadRuntime));
		await handlers.get("session_start")?.({}, ctx);

		expect(loadRuntime).toHaveBeenCalledOnce();
		expect(createRuntime).toHaveBeenCalledOnce();
		expect(startSession).toHaveBeenCalledTimes(2);
	});

	it("native runtime 动态加载失败时通知并保持非 TUI 隔离", async () => {
		const loadRuntime = vi.fn(async () => {
			throw new Error("runtime unavailable");
		});
		const { calls } = await startTui({ mode: "tui" }, {}, createTuiExtension(undefined, loadRuntime));

		expect(calls.notifications).toHaveLength(1);
		expect(calls.notifications[0]).toMatchObject({ message: expect.stringContaining("runtime unavailable"), type: "warning" });
		expect(calls.title).toEqual([]);
		expect(calls.status).toEqual([]);
	});

	it("native runtime session 初始化失败时清理已创建资源", async () => {
		const startSession = vi.fn(async () => {
			throw new Error("config unavailable");
		});
		const dispose = vi.fn();
		const loadRuntime = vi.fn(async () => ({ createTuiRuntime: () => ({ startSession, dispose }) }));
		const { calls, ctx } = await startTui({ mode: "tui" }, {}, createTuiExtension(undefined, loadRuntime));

		expect(dispose).toHaveBeenCalledWith(ctx);
		expect(calls.notifications).toHaveLength(1);
		expect(calls.notifications[0]).toMatchObject({ message: expect.stringContaining("config unavailable"), type: "warning" });
	});

	it("数学渲染器只在 startup 和 agent_settled 后尝试一次空闲初始化", async () => {
		vi.useFakeTimers();
		let idle = true;
		const math = createMathFixture();
		const { handlers, ctx, runtime } = await startRuntime({
			context: { mode: "tui", isIdle: () => idle },
			loadMathMarkdown: math.load,
			notifyUser: async () => {},
		});
		expect(math.load).not.toHaveBeenCalled();

		await handlers.get("agent_start")?.({}, ctx);
		expect(vi.getTimerCount()).toBe(0);

		idle = false;
		await handlers.get("agent_settled")?.({}, ctx);
		await vi.advanceTimersToNextTimerAsync();
		expect(math.load).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);

		idle = true;
		await handlers.get("agent_settled")?.({}, ctx);
		await vi.advanceTimersToNextTimerAsync();
		await Promise.resolve();
		expect(math.load).toHaveBeenCalledOnce();
		expect(math.install).toHaveBeenCalledOnce();
		expect(math.warm).toHaveBeenCalledOnce();

		await handlers.get("agent_settled")?.({}, ctx);
		expect(vi.getTimerCount()).toBe(0);
		await runtime.dispose(ctx as unknown as Parameters<typeof runtime.dispose>[0]);
	});

	it("动态加载完成后若 Agent 已运行则等待下一次 settled", async () => {
		vi.useFakeTimers();
		let idle = true;
		const math = createMathFixture();
		let releaseLoad: (() => void) | undefined;
		const load = vi.fn(() => new Promise<MathMarkdownModule>((resolve) => {
			releaseLoad = () => resolve(math.module);
		}));
		const { handlers, ctx, runtime } = await startRuntime({
			context: { mode: "tui", isIdle: () => idle },
			loadMathMarkdown: load,
			notifyUser: async () => {},
		});
		await vi.advanceTimersToNextTimerAsync();
		expect(load).toHaveBeenCalledOnce();

		idle = false;
		await handlers.get("agent_start")?.({}, ctx);
		releaseLoad?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(math.install).not.toHaveBeenCalled();
		expect(math.warm).not.toHaveBeenCalled();

		idle = true;
		await handlers.get("agent_settled")?.({}, ctx);
		await vi.advanceTimersToNextTimerAsync();
		expect(load).toHaveBeenCalledOnce();
		expect(math.install).toHaveBeenCalledOnce();
		expect(math.warm).toHaveBeenCalledOnce();
		await runtime.dispose(ctx as unknown as Parameters<typeof runtime.dispose>[0]);
	});

	it("字体加载失败由 runtime 警告且不会标记为 warmed", async () => {
		vi.useFakeTimers();
		const error = new Error("font unavailable");
		const math = createMathFixture(async () => { throw error; });
		const { handlers, calls, ctx, runtime } = await startRuntime({
			loadMathMarkdown: math.load,
			notifyUser: async () => {},
		});
		await vi.advanceTimersToNextTimerAsync();
		expect(math.warm).toHaveBeenCalledOnce();
		expect(calls.notifications.at(-1)).toMatchObject({
			message: expect.stringContaining("font unavailable"),
			type: "warning",
		});

		await handlers.get("agent_settled")?.({}, ctx);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersToNextTimerAsync();
		expect(math.warm).toHaveBeenCalledTimes(2);
		expect(calls.notifications).toHaveLength(2);
		await runtime.dispose(ctx as unknown as Parameters<typeof runtime.dispose>[0]);
	});

	it("session 关闭会取消尚未开始的数学渲染初始化", async () => {
		vi.useFakeTimers();
		const math = createMathFixture();
		const { handlers, ctx } = await startTui({ mode: "tui" }, {}, createTuiExtension(math.load));
		await handlers.get("session_shutdown")?.({}, ctx);
		await vi.runAllTimersAsync();

		expect(math.load).not.toHaveBeenCalled();
	});
});

function performanceMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Hello world" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function plainEditorTheme(): EditorTheme {
	const identity = (text: string): string => text;
	return {
		borderColor: identity,
		selectList: {
			selectedPrefix: identity,
			selectedText: identity,
			description: identity,
			scrollInfo: identity,
			noMatch: identity,
		},
	};
}

function createFooterData(): FooterDataStub {
	return createFooterDataController(null).data;
}

function createFooterDataController(initialBranch: string | null): {
	data: FooterDataStub;
	setBranch(branch: string | null): void;
	subscriberCount(): number;
} {
	let branch = initialBranch;
	const callbacks = new Set<() => void>();
	return {
		data: {
			getGitBranch: () => branch,
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 1,
			onBranchChange(callback) {
				callbacks.add(callback);
				return () => callbacks.delete(callback);
			},
		},
		setBranch(nextBranch) {
			branch = nextBranch;
			for (const callback of callbacks) callback();
		},
		subscriberCount: () => callbacks.size,
	};
}

async function startRuntime(options: {
	context?: Parameters<typeof createContext>[1];
	loadMathMarkdown?: Parameters<typeof createTuiRuntime>[1];
	notifyUser?: Parameters<typeof createTuiRuntime>[2];
} = {}) {
	const handlers = new Map<string, Handler>();
	const calls = createUiCalls();
	const ctx = createContext(calls, options.context);
	const runtime = createTuiRuntime(createPi(handlers) as unknown as ExtensionAPI, options.loadMathMarkdown, options.notifyUser);
	await runtime.startSession(ctx as unknown as Parameters<typeof runtime.startSession>[0]);
	return { handlers, calls, ctx, runtime };
}

function createMathFixture(warmDisplayMathRenderer: () => Promise<void> = async () => {}) {
	const install = vi.fn();
	const warm = vi.fn(warmDisplayMathRenderer);
	const module: MathMarkdownModule = {
		installMathMarkdownRenderer: install,
		supportsDisplayMathImages: () => true,
		warmDisplayMathRenderer: warm,
	};
	return { install, warm, module, load: vi.fn(async () => module) };
}

async function startTui(
	options: Parameters<typeof createContext>[1] = {},
	piOptions: Parameters<typeof createPi>[1] = {},
	extension: (pi: ExtensionAPI) => void = tuiExtension,
): Promise<{ handlers: Map<string, Handler>; calls: ReturnType<typeof createUiCalls>; ctx: ExtensionContextStub }> {
	const handlers = new Map<string, Handler>();
	const calls = createUiCalls();
	const ctx = createContext(calls, options);
	extension(createPi(handlers, piOptions) as unknown as ExtensionAPI);
	await handlers.get("session_start")?.({}, ctx);
	return { handlers, calls, ctx };
}

function createPi(
	handlers: Map<string, Handler>,
	options: { getActiveTools?: () => string[] } = {},
) {
	return {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		getThinkingLevel() {
			return "medium";
		},
		getSessionName() {
			return undefined;
		},
		getAllTools() {
			return [{ name: "read" }, { name: "grep" }, { name: "bash" }];
		},
		getActiveTools: options.getActiveTools ?? (() => ["read"]),
		getCommands() {
			return [];
		},
	};
}

function createContext(
	calls: ReturnType<typeof createUiCalls>,
	options: {
		mode?: ExtensionContextStub["mode"];
		isIdle?: () => boolean;
		hasPendingMessages?: () => boolean;
		entries?: SessionEntryStub[];
	} = {},
): ExtensionContextStub {
	return {
		cwd: process.cwd(),
		mode: options.mode ?? "tui",
		ui: {
			theme: { fg: (_name, text) => text, bg: (_name, text) => text },
			notify(message, type) {
				calls.notifications.push({ message, type });
			},
			setTitle(title) {
				calls.title.push(title);
			},
			setStatus(key, text) {
				calls.status.push({ key, text });
			},
			setFooter(factory) {
				calls.footer.push(factory);
			},
			setHeader(factory) {
				calls.header.push(factory);
			},
			setWorkingIndicator(options) {
				calls.working.push(options);
			},
			setEditorComponent(factory) {
				calls.editor.push(factory);
			},
			getEditorComponent() {
				return calls.editor.at(-1);
			},
		},
		getContextUsage() {
			return undefined;
		},
		isIdle: options.isIdle ?? (() => true),
		hasPendingMessages: options.hasPendingMessages ?? (() => false),
		model: undefined,
		modelRegistry: { isUsingOAuth: () => false, getAvailable: () => [] },
		sessionManager: { getEntries: () => options.entries ?? [], buildContextEntries: () => [], getSessionId: () => "session-test" },
	};
}

function createUiCalls() {
	return {
		title: [] as string[],
		status: [] as Array<{ key: string; text: string | undefined }>,
		footer: [] as Array<FooterFactory | undefined>,
		header: [] as Array<HeaderFactory | undefined>,
		working: [] as unknown[],
		editor: [] as Array<EditorFactoryStub | undefined>,
		notifications: [] as Array<{ message: string; type: string | undefined }>,
	};
}
