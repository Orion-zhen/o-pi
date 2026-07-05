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
});
