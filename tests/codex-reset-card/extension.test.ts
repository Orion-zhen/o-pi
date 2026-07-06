import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import codexResetCardExtension from "../../agent/extensions/codex-reset-card.js";

describe("codex reset card extension", () => {
	it("注册 /codex-reset-card 命令", () => {
		type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
		let commandName: string | undefined;
		let commandOptions: CommandOptions | undefined;

		codexResetCardExtension({
			registerCommand(name, options) {
				commandName = name;
				commandOptions = options;
			},
		});

		expect(commandName).toBe("codex-reset-card");
		expect(commandOptions?.description).toBe("Show Codex reset cards.");
	});
});
