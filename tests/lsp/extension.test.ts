import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import lspExtension from "../../agent/extensions/lsp.js";
import { registerLspCommands } from "../../src/lsp/commands.js";
import { LspManager } from "../../src/lsp/manager.js";

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

	it("/lsp 合并 status、reload、diagnostics 和 usage 分支", async () => {
		type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
		let options: CommandOptions | undefined;
		let reloads = 0;
		let diagnosticsTarget: string | undefined;
		const manager = new LspManager();
		vi.spyOn(manager, "status").mockResolvedValue({
			enabled: true,
			config_path: "/config/lsp.jsonc",
			servers: [{ id: "ts", status: "ready", root: "/repo", open_documents: 1, diagnostics: 1, restarts: 0 }],
		});
		vi.spyOn(manager, "reload").mockImplementation(async () => {
			reloads += 1;
		});
		vi.spyOn(manager, "knownDiagnostics").mockImplementation(async (_cwd, target) => {
			diagnosticsTarget = target;
			return [{ path: "src/a.ts", items: [{ severity: "error", line: 2, column: 3, message: "broken", code: "TS1" }] }];
		});
		registerLspCommands({
			registerCommand(_name, commandOptions) {
				options = commandOptions;
			},
		}, manager);
		if (options === undefined) throw new Error("lsp command not registered");
		const notifications: Array<{ message: string; level: string | undefined }> = [];
		const ctx = {
			cwd: "/repo",
			ui: {
				notify(message: string, level?: string) {
					notifications.push({ message, level });
				},
			},
		} as never;

		await options.handler("status", ctx);
		await options.handler("reload", ctx);
		await options.handler("diagnostics src/a.ts", ctx);
		await options.handler("bad", ctx);

		expect(reloads).toBe(1);
		expect(diagnosticsTarget).toBe("src/a.ts");
		expect(notifications).toMatchObject([
			{ message: expect.stringContaining("ts · ready"), level: "info" },
			{ message: "LSP reloaded", level: "info" },
			{ message: expect.stringContaining("error 2:3 broken (TS1)"), level: "error" },
			{ message: expect.stringContaining("usage: /lsp"), level: "warning" },
		]);
	});
});
