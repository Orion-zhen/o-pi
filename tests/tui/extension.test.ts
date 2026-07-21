import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import tuiExtension, { createTuiExtension } from "../../agent/extensions/tui.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

type Handler = (event: unknown, ctx: ExtensionContextStub) => Promise<void> | void;
type FooterFactory = (tui: { requestRender(): void }, theme: ThemeStub, footerData: FooterDataStub) => Component;
type HeaderFactory = (tui: { requestRender(): void }, theme: ThemeStub) => Component;

interface ThemeStub {
	fg(_name: string, text: string): string;
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
	};
	getContextUsage(): undefined;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	model: ModelStub | undefined;
	modelRegistry: { isUsingOAuth(model: ModelStub): boolean };
	sessionManager: { getEntries(): unknown[] };
}

interface ModelStub {
	provider: string;
	id: string;
	reasoning?: boolean;
}

let dir: string;
const temp = useTempDir("o-pi-tui-extension-");
preserveEnv("PI_TUI_CONFIG");

beforeEach(() => {
	dir = temp.path;
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
			mode: "print",
			ui: {
				theme: { fg: (_name, text) => text },
				notify() {},
				setTitle() {},
				setStatus() {},
				setFooter(factory) {
					footerFactory = factory;
				},
				setHeader() {},
				setWorkingIndicator() {},
			},
			getContextUsage() {
				return undefined;
			},
			isIdle: () => true,
			hasPendingMessages: () => false,
			model: undefined,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: { getEntries: () => [] },
		};

		tuiExtension(pi as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);

		const component = footerFactory?.({ requestRender() {} }, ctx.ui.theme, createFooterData());

		expect(component?.render(80).join("\n")).toContain("1/3 tools enabled");
		activeTools = ["grep", "bash"];
		const output = component?.render(80).join("\n") ?? "";
		expect(output).not.toContain("grep bash");
		expect(output).toContain("2/3 tools enabled");

		const busyFooter = footerFactory?.(
			{ requestRender() {} },
			ctx.ui.theme,
			createFooterData(new Map([
				["o-pi:tui", "✓ ready"],
				["repo-map", "Repo Map: preparing"],
				["other", "Other: busy"],
			])),
		);
		const busyOutput = busyFooter?.render(120).join("\n") ?? "";
		expect(busyOutput).toContain("Repo Map: preparing");
		expect(busyOutput).toContain("ready");
		expect(busyOutput).not.toContain("Other: busy");
	});

	it("session_start 设置 footer/status/working indicator 和 startup banner header", async () => {
		await mkdir(path.join(dir, "alpha-user"));
		await mkdir(path.join(dir, "alpha-project"));
		await mkdir(path.join(dir, "beta"));
		await writeFile(path.join(dir, "alpha-user", "SKILL.md"), "---\nname: alpha\ndescription: alpha user\n---\n正文\n");
		await writeFile(path.join(dir, "alpha-project", "SKILL.md"), "---\nname: alpha\ndescription: alpha project\ndisable-model-invocation: false\n---\n正文\n");
		await writeFile(path.join(dir, "beta", "SKILL.md"), "---\nname: beta\ndescription: beta\n---\n正文\n");
		const handlers = new Map<string, Handler>();
		const calls = createUiCalls();
		const pi = createPi(handlers);
		const ctx = createContext(calls);

		tuiExtension(pi as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);

		expect(calls.footer.at(-1)).toBeTypeOf("function");
		expect(calls.status).toContainEqual({ key: "o-pi:tui", text: "✓ ready" });
		expect(calls.working.length).toBeGreaterThan(0);
		const header = calls.header.at(-1);
		expect(header).toBeTypeOf("function");
		const output = header?.({ requestRender() {} }, ctx.ui.theme).render(120).join("\n") ?? "";
		expect(output).toContain("██████");
		expect(output).toContain("tools");
		expect(output).toContain("skills     2 · model:2");
	});

	it("turn_start 默认保留 startup banner", async () => {
		const handlers = new Map<string, Handler>();
		const calls = createUiCalls();
		const pi = createPi(handlers);
		const ctx = createContext(calls);

		tuiExtension(pi as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("turn_start")?.({}, ctx);

		const header = calls.header.at(-1);
		expect(header).toBeTypeOf("function");
		const output = header?.({ requestRender() {} }, ctx.ui.theme).render(120).join("\n") ?? "";
		expect(output).toContain("██████");
		expect(calls.status.at(-1)).toEqual({ key: "o-pi:tui", text: "● running" });
	});

	it("turn_start 清掉 banner 后可恢复普通 one-line header", async () => {
		const file = path.join(dir, "tui.jsonc");
		await writeFile(file, '{ "chrome": { "header": true }, "banner": { "clear_on_first_turn": true } }');
		process.env["PI_TUI_CONFIG"] = file;
		const handlers = new Map<string, Handler>();
		const calls = createUiCalls();
		const pi = createPi(handlers);
		const ctx = createContext(calls);

		tuiExtension(pi as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("turn_start")?.({}, ctx);

		const header = calls.header.at(-1);
		expect(header).toBeTypeOf("function");
		const output = header?.({ requestRender() {} }, ctx.ui.theme).render(120).join("\n") ?? "";
		expect(output).toContain("π o-pi");
		expect(output).not.toContain("____");
	});

	it("首轮对话前 model_select 会刷新 footer、title 和 startup banner", async () => {
		const handlers = new Map<string, Handler>();
		const calls = createUiCalls();
		const pi = createPi(handlers);
		const ctx = createContext(calls);

		tuiExtension(pi as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);
		ctx.model = { provider: "openai", id: "gpt-5.2", reasoning: true };
		await handlers.get("model_select")?.({ type: "model_select", model: ctx.model, previousModel: undefined, source: "set" }, ctx);

		const footer = calls.footer.at(-1)?.({ requestRender() {} }, ctx.ui.theme, createFooterData());
		const header = calls.header.at(-1)?.({ requestRender() {} }, ctx.ui.theme);
		expect(footer?.render(120).join("\n")).toContain("gpt-5.2 • medium");
		expect(header?.render(120).join("\n")).toContain("gpt-5.2 • medium");
		expect(calls.title.at(-1)).toContain("gpt-5.2");
		expect(calls.status.at(-1)).toEqual({ key: "o-pi:tui", text: "✓ ready" });
	});

	it("session_shutdown 清理 header/footer/status", async () => {
		const handlers = new Map<string, Handler>();
		const calls = createUiCalls();
		const pi = createPi(handlers);
		const ctx = createContext(calls);

		tuiExtension(pi as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("session_shutdown")?.({}, ctx);

		expect(calls.header.at(-1)).toBeUndefined();
		expect(calls.footer.at(-1)).toBeUndefined();
		expect(calls.status.at(-1)).toEqual({ key: "o-pi:tui", text: undefined });
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

function createFooterData(statuses: ReadonlyMap<string, string> = new Map()): FooterDataStub {
	return {
		getGitBranch: () => null,
		getExtensionStatuses: () => statuses,
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
			return [
				{ name: "skill:alpha", source: "skill", sourceInfo: { path: path.join(dir, "alpha-user", "SKILL.md"), source: "local", scope: "user", origin: "top-level" } },
				{ name: "skill:alpha", source: "skill", sourceInfo: { path: path.join(dir, "alpha-project", "SKILL.md"), source: "local", scope: "project", origin: "top-level" } },
				{ name: "skill:beta", source: "skill", sourceInfo: { path: path.join(dir, "beta", "SKILL.md"), source: "local", scope: "project", origin: "top-level" } },
				{ name: "stats", source: "extension", sourceInfo: { path: "/home/me/.pi/agent/extensions/stats.ts", source: "local", scope: "user", origin: "top-level" } },
			];
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
		mode: options.mode ?? "print",
		ui: {
			theme: { fg: (_name, text) => text },
			notify() {},
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
		},
		getContextUsage() {
			return undefined;
		},
		isIdle: options.isIdle ?? (() => true),
		hasPendingMessages: options.hasPendingMessages ?? (() => false),
		model: undefined,
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: { getEntries: () => [] },
	};
}

function createUiCalls() {
	return {
		title: [] as string[],
		status: [] as Array<{ key: string; text: string | undefined }>,
		footer: [] as Array<FooterFactory | undefined>,
		header: [] as Array<HeaderFactory | undefined>,
		working: [] as unknown[],
	};
}
