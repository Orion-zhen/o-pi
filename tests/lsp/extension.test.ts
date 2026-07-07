import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import lspExtension from "../../agent/extensions/lsp.js";

describe("lsp extension", () => {
	it("只注册 /lsp 命令，不注册模型工具", () => {
		const commands: string[] = [];
		const tools: string[] = [];
		lspExtension({
			registerCommand(name) {
				commands.push(name);
			},
			registerTool(tool) {
				tools.push(tool.name);
			},
		} as Pick<ExtensionAPI, "registerCommand" | "registerTool"> as ExtensionAPI);

		expect(commands).toEqual(["lsp"]);
		expect(tools).toEqual([]);
	});
});
