import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import tuiExtension, { createTuiExtension } from "../../agent/extensions/tui.js";
import { getAssistantPerformance } from "../../src/tui/message-performance.js";
import { createTuiRuntime } from "../../src/tui/runtime.js";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.js";

type Handler = (event: unknown, ctx: ExtensionContextStub) => Promise<void> | void;
type FooterFactory = (tui: { requestRender(): void }, theme: ThemeStub, footerData: FooterDataStub) => Component;
type HeaderFactory = (tui: { requestRender(): void }, theme: ThemeStub) => Component;
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
	modelRegistry: { isUsingOAuth(model: ModelStub): boolean };
	sessionManager: { getEntries(): unknown[]; buildContextEntries(): never[]; getSessionId(): string };
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
	it("注册 footer，并在渲染时读取当前工具启用状态", async () => {
		const handlers = new Map<string, Handler>();
		let footerFactory: FooterFactory | undefined;
		let activeTools = ["read"];
		const allTools = [{ name: "read" }, { name: "grep" }, { name: "bash" }];

		const pi = {
			on(name: string, handler: Handler) {
				handlers.set(name, handler);
			},
			getThinkingLevel() {
				return "medium";
			},
			getAllTools() {
				return allTools;
			},
			getActiveTools() {
				return activeTools;
			},
			getCommands() {
				return [];
			},
		};

		const ctx: ExtensionContextStub = {
			cwd: process.cwd(),
			mode: "tui",
			ui: {
				theme: { fg: (_name, text) => text, bg: (_name, text) => text },
				notify() {},
				setTitle() {},
				setStatus() {},
				setFooter(factory) {
					footerFactory = factory;
				},
				setHeader() {},
				setWorkingIndicator() {},
				setEditorComponent() {},
				getEditorComponent: () => undefined,
			},
			getContextUsage() {
				return undefined;
			},
			isIdle: () => true,
			hasPendingMessages: () => false,
			model: undefined,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: { getEntries: () => [], buildContextEntries: () => [], getSessionId: () => "session-test" },
		};

		tuiExtension(pi as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);

		const component = footerFactory?.({ requestRender() {} }, ctx.ui.theme, createFooterData());

		expect(component?.render(80).join("\n")).toMatch(/\b1\/3\b/u);
		activeTools = ["grep", "bash"];
		expect(component?.render(80).join("\n")).toMatch(/\b2\/3\b/u);
	});

	it("session_start 初始化 chrome，首轮默认保留 startup header", async () => {
		const handlers = new Map<string, Handler>();
		const calls = createUiCalls();
		const pi = createPi(handlers);
		const ctx = createContext(calls, { mode: "tui" });

		tuiExtension(pi as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);

		expect(calls.footer.at(-1)).toBeTypeOf("function");
		expect(calls.editor.at(-1)).toBeTypeOf("function");
		expect(calls.status.at(-1)).toMatchObject({ key: "o-pi:tui", text: expect.any(String) });
		expect(calls.working.length).toBeGreaterThan(0);
		const startupHeader = calls.header.at(-1);
		expect(startupHeader).toBeTypeOf("function");
		const headerCount = calls.header.length;
		await handlers.get("turn_start")?.({}, ctx);

		expect(calls.header).toHaveLength(headerCount);
		expect(calls.header.at(-1)).toBe(startupHeader);
		expect(calls.status.at(-1)).toMatchObject({ key: "o-pi:tui", text: expect.any(String) });
	});

	it("turn_start 按配置替换 startup header", async () => {
		const file = path.join(dir, "tui.jsonc");
		await writeFile(file, '{ "chrome": { "header": true }, "banner": { "clear_on_first_turn": true } }');
		process.env["PI_TUI_CONFIG"] = file;
		const handlers = new Map<string, Handler>();
		const calls = createUiCalls();
		const pi = createPi(handlers);
		const ctx = createContext(calls, { mode: "tui" });

		tuiExtension(pi as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);
		const startupHeader = calls.header.at(-1);
		await handlers.get("turn_start")?.({}, ctx);

		expect(calls.header.at(-1)).toBeTypeOf("function");
		expect(calls.header.at(-1)).not.toBe(startupHeader);
	});

	it("首轮对话前 model_select 会刷新 footer、title 和 startup banner", async () => {
		const handlers = new Map<string, Handler>();
		const calls = createUiCalls();
		const pi = createPi(handlers);
		const ctx = createContext(calls, { mode: "tui" });

		tuiExtension(pi as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);
		ctx.model = { provider: "openai", id: "gpt-5.2", reasoning: true };
		await handlers.get("model_select")?.({ type: "model_select", model: ctx.model, previousModel: undefined, source: "set" }, ctx);

		const footer = calls.footer.at(-1)?.({ requestRender() {} }, ctx.ui.theme, createFooterData());
		const header = calls.header.at(-1)?.({ requestRender() {} }, ctx.ui.theme);
		expect(footer?.render(120).join("\n")).toContain("gpt-5.2");
		expect(header?.render(120).join("\n")).toContain("gpt-5.2");
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

	it("agent_settled 不受通知失败影响", async () => {
		const handlers = new Map<string, Handler>();
		createTuiRuntime(createPi(handlers) as unknown as ExtensionAPI, undefined, async () => {
			throw new Error("notification unavailable");
		});

		await expect(
			handlers.get("agent_settled")?.({}, createContext(createUiCalls(), { mode: "tui" })),
		).resolves.toBeUndefined();
	});

	it("provider 和消息事件接入模型性能跟踪", async () => {
		const handlers = new Map<string, Handler>();
		const ctx = createContext(createUiCalls(), { mode: "tui" });
		const runtime = createTuiRuntime(createPi(handlers) as unknown as ExtensionAPI);
		await runtime.startSession(ctx as unknown as Parameters<typeof runtime.startSession>[0]);
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
		const handlers = new Map<string, Handler>();
		const calls = createUiCalls();
		const pi = createPi(handlers);
		const ctx = createContext(calls, { mode: "tui" });

		tuiExtension(pi as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);
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
		const calls = createUiCalls();
		const handlers = new Map<string, Handler>();
		const ctx = createContext(calls, { mode });

		createTuiExtension(undefined, loadRuntime)(createPi(handlers) as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);

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
		const handlers = new Map<string, Handler>();
		const ctx = createContext(createUiCalls(), { mode: "tui" });

		createTuiExtension(undefined, loadRuntime)(createPi(handlers) as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("session_start")?.({}, ctx);

		expect(loadRuntime).toHaveBeenCalledOnce();
		expect(createRuntime).toHaveBeenCalledOnce();
		expect(startSession).toHaveBeenCalledTimes(2);
	});

	it("native runtime 动态加载失败时通知并保持非 TUI 隔离", async () => {
		const loadRuntime = vi.fn(async () => {
			throw new Error("runtime unavailable");
		});
		const handlers = new Map<string, Handler>();
		const calls = createUiCalls();
		const ctx = createContext(calls, { mode: "tui" });

		createTuiExtension(undefined, loadRuntime)(createPi(handlers) as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);

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
		const handlers = new Map<string, Handler>();
		const calls = createUiCalls();
		const ctx = createContext(calls, { mode: "tui" });

		createTuiExtension(undefined, loadRuntime)(createPi(handlers) as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);

		expect(dispose).toHaveBeenCalledWith(ctx);
		expect(calls.notifications).toHaveLength(1);
		expect(calls.notifications[0]).toMatchObject({ message: expect.stringContaining("config unavailable"), type: "warning" });
	});

	it("数学渲染器只在 TUI 空闲期加载，并在活跃 turn 期间暂停", async () => {
		vi.useFakeTimers();
		let idle = true;
		const install = vi.fn();
		const warm = vi.fn(async () => {});
		const load = vi.fn(async () => ({
			installMathMarkdownRenderer: install,
			supportsDisplayMathImages: () => true,
			warmDisplayMathRenderer: warm,
		}));
		const handlers = new Map<string, Handler>();
		const calls = createUiCalls();
		const ctx = createContext(calls, {
			mode: "tui",
			isIdle: () => idle,
		});

		createTuiExtension(load)(createPi(handlers) as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);
		expect(load).not.toHaveBeenCalled();

		await handlers.get("turn_start")?.({}, ctx);
		expect(vi.getTimerCount()).toBe(0);

		idle = false;
		await handlers.get("turn_end")?.({}, ctx);
		await vi.advanceTimersToNextTimerAsync();
		expect(load).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);

		idle = true;
		await vi.advanceTimersToNextTimerAsync();
		await Promise.resolve();
		expect(load).toHaveBeenCalledOnce();
		expect(install).toHaveBeenCalledOnce();
		expect(warm).toHaveBeenCalledOnce();

		await handlers.get("turn_end")?.({}, ctx);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("session 关闭会取消尚未开始的数学渲染初始化", async () => {
		vi.useFakeTimers();
		const load = vi.fn(async () => ({
			installMathMarkdownRenderer() {},
			supportsDisplayMathImages: () => true,
			async warmDisplayMathRenderer() {},
		}));
		const handlers = new Map<string, Handler>();
		const ctx = createContext(createUiCalls(), { mode: "tui" });

		createTuiExtension(load)(createPi(handlers) as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("session_shutdown")?.({}, ctx);
		await vi.runAllTimersAsync();

		expect(load).not.toHaveBeenCalled();
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

function createFooterData(): FooterDataStub {
	return {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

function createPi(handlers: Map<string, Handler>) {
	return {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		getThinkingLevel() {
			return "medium";
		},
		getAllTools() {
			return [{ name: "read" }, { name: "grep" }, { name: "bash" }];
		},
		getActiveTools() {
			return ["read"];
		},
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
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: { getEntries: () => [], buildContextEntries: () => [], getSessionId: () => "session-test" },
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
