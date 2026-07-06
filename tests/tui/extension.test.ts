import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import tuiExtension from "../../agent/extensions/tui.js";

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
	ui: {
		theme: ThemeStub;
		setTitle(title: string): void;
		setStatus(key: string, text: string | undefined): void;
		setFooter(factory: FooterFactory | undefined): void;
		setHeader(factory: HeaderFactory | undefined): void;
		setWorkingIndicator(options?: unknown): void;
	};
	getContextUsage(): undefined;
	model: undefined;
	modelRegistry: { isUsingOAuth(): boolean };
	sessionManager: { getEntries(): unknown[] };
}

let dir: string;
let originalConfigPath: string | undefined;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "o-pi-tui-extension-"));
	originalConfigPath = process.env["PI_TUI_CONFIG"];
});

afterEach(async () => {
	if (originalConfigPath === undefined) delete process.env["PI_TUI_CONFIG"];
	else process.env["PI_TUI_CONFIG"] = originalConfigPath;
	await rm(dir, { recursive: true, force: true });
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
			ui: {
				theme: { fg: (_name, text) => text },
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
			model: undefined,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: { getEntries: () => [] },
		};

		tuiExtension(pi as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);

		const component = footerFactory?.({ requestRender() {} }, ctx.ui.theme, {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => {},
		});

		expect(component?.render(80).join("\n")).toContain("1/3 tools enabled");
		activeTools = ["grep", "bash"];
		const output = component?.render(80).join("\n") ?? "";
		expect(output).not.toContain("grep bash");
		expect(output).toContain("2/3 tools enabled");
	});

	it("session_start 设置 footer/status/working indicator 和 startup banner header", async () => {
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
		expect(output).toContain("____");
		expect(output).toContain("tools");
		expect(output).toContain("skills     2 · user:1 · project:1");
	});

	it("turn_start 可清掉 banner，chrome.header false 时清空 header", async () => {
		const handlers = new Map<string, Handler>();
		const calls = createUiCalls();
		const pi = createPi(handlers);
		const ctx = createContext(calls);

		tuiExtension(pi as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("turn_start")?.({}, ctx);

		expect(calls.header.at(-1)).toBeUndefined();
		expect(calls.status.at(-1)).toEqual({ key: "o-pi:tui", text: "● running" });
	});

	it("turn_start 清掉 banner 后可恢复普通 one-line header", async () => {
		const file = path.join(dir, "tui.jsonc");
		await writeFile(file, '{ "version": 1, "chrome": { "header": true } }');
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
});

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
				{ name: "skill:alpha", source: "skill", sourceInfo: { path: "/home/me/.pi/agent/skills/alpha/SKILL.md", source: "local", scope: "user", origin: "top-level" } },
				{ name: "skill:beta", source: "skill", sourceInfo: { path: "/repo/.pi/skills/beta/SKILL.md", source: "local", scope: "project", origin: "top-level" } },
				{ name: "stats", source: "extension", sourceInfo: { path: "/home/me/.pi/agent/extensions/stats.ts", source: "local", scope: "user", origin: "top-level" } },
			];
		},
	};
}

function createContext(calls: ReturnType<typeof createUiCalls>): ExtensionContextStub {
	return {
		cwd: process.cwd(),
		ui: {
			theme: { fg: (_name, text) => text },
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
