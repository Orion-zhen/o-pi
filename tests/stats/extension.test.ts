import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import statsExtension from "../../agent/extensions/stats.js";

describe("stats extension", () => {
	it("注册 /stats，并在非 TUI 模式提示错误而非抛异常", async () => {
		type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
		let commandName: string | undefined;
		let commandOptions: CommandOptions | undefined;
		let notification: { message: string; type: string | undefined } | undefined;

		const pi = {
			registerCommand(name, options) {
				commandName = name;
				commandOptions = options;
			},
			getAllTools: () => [],
			getActiveTools: () => [],
			getThinkingLevel: () => "medium",
		} satisfies Pick<ExtensionAPI, "registerCommand" | "getAllTools" | "getActiveTools" | "getThinkingLevel">;

		statsExtension(pi);

		await commandOptions?.handler("", {
			mode: "print",
			ui: {
				notify(message: string, type: "info" | "warning" | "error" | undefined) {
					notification = { message, type };
				},
			},
		} as Parameters<NonNullable<typeof commandOptions>["handler"]>[1]);

		expect(commandName).toBe("stats");
		expect(commandOptions?.description).toBe("Show current session stats.");
		expect(notification).toEqual({ message: "/stats requires TUI mode", type: "error" });
	});

	it("TUI 浮层使用响应式宽度并保留最小宽度", async () => {
		type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
		let commandOptions: CommandOptions | undefined;
		let customOptions: unknown;

		const pi = {
			registerCommand(_name, options) {
				commandOptions = options;
			},
			getAllTools: () => [],
			getActiveTools: () => [],
			getThinkingLevel: () => "medium",
		} satisfies Pick<ExtensionAPI, "registerCommand" | "getAllTools" | "getActiveTools" | "getThinkingLevel">;

		statsExtension(pi);
		await commandOptions?.handler("", fixture<Parameters<NonNullable<typeof commandOptions>["handler"]>[1]>({
			mode: "tui",
			cwd: "/repo",
			model: undefined,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: { getEntries: () => [], getBranch: () => [] },
			getContextUsage: () => undefined,
			getSystemPrompt: () => "",
			getSystemPromptOptions: () => undefined,
			isIdle: () => true,
			ui: {
				async custom(_factory: unknown, options: unknown) {
					customOptions = options;
				},
			},
		}));

		expect(customOptions).toMatchObject({ overlay: true, overlayOptions: { width: "90%", minWidth: 80 } });
	});
});

function fixture<T>(value: unknown): T {
	return value as T;
}
