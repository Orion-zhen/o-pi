import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import quotaExtension from "../../agent/extensions/quota.js";

describe("quota extension", () => {
	it("注册 /quota 命令", () => {
		type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
		let commandName: string | undefined;
		let commandOptions: CommandOptions | undefined;

		quotaExtension({
			registerCommand(name, options) {
				commandName = name;
				commandOptions = options;
			},
		});

		expect(commandName).toBe("quota");
		expect(commandOptions?.description).toBe("Show Codex quota and reset credits.");
	});
});
