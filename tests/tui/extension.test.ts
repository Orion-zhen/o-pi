import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import tuiExtension from "../../agent/extensions/tui.js";

type Handler = (event: unknown, ctx: ExtensionContextStub) => Promise<void> | void;
type FooterFactory = (tui: { requestRender(): void }, theme: ThemeStub, footerData: FooterDataStub) => Component;

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
		setHeader(factory: unknown): void;
		setWorkingIndicator(options?: unknown): void;
	};
	getContextUsage(): undefined;
	model: undefined;
	modelRegistry: { isUsingOAuth(): boolean };
	sessionManager: { getEntries(): unknown[] };
}

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
});
