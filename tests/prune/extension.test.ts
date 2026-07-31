import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import pruneExtension from "../../agent/extensions/prune.js";

describe("prune extension adapter", () => {
	it("只注册 /prune，启动前不注册 TUI renderer，并保留 force 与 restore 补全", async () => {
		const registrations = captureRegistrations();
		expect(registrations.commands).toEqual(["prune"]);
		expect(registrations.entryRenderers).toEqual([]);
		expect(registrations.events).toEqual(expect.arrayContaining([
			"context",
			"session_start",
			"session_tree",
			"session_shutdown",
		]));
		const complete = registrations.commandOptions[0]?.getArgumentCompletions;
		expect(complete).toBeTypeOf("function");
		if (!complete) throw new Error("missing prune argument completions");
		expect(await complete("f")).toEqual([{ label: "force", value: "force" }]);
		expect(await complete(" REST ")).toEqual([{ label: "restore", value: "restore" }]);
		expect(await complete("invalid")).toBeNull();
	});
});

function captureRegistrations(): {
	commands: string[];
	commandOptions: Array<Parameters<ExtensionAPI["registerCommand"]>[1]>;
	entryRenderers: string[];
	events: string[];
} {
	const commands: string[] = [];
	const commandOptions: Array<Parameters<ExtensionAPI["registerCommand"]>[1]> = [];
	const entryRenderers: string[] = [];
	const events: string[] = [];
	const api: Pick<
		ExtensionAPI,
		"appendEntry" | "getActiveTools" | "getAllTools" | "on" | "registerCommand" | "registerEntryRenderer"
	> = {
		appendEntry() {},
		getActiveTools: () => [],
		getAllTools: () => [],
		on(event) {
			events.push(event);
		},
		registerCommand(name, options) {
			commands.push(name);
			commandOptions.push(options);
		},
		registerEntryRenderer(customType) {
			entryRenderers.push(customType);
		},
	};
	pruneExtension(api);
	return { commands, commandOptions, entryRenderers, events };
}
