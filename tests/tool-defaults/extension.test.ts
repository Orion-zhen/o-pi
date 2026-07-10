import type { ExtensionAPI, ExtensionContext, SessionStartEvent, SessionTreeEvent, ToolInfo } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import toolsExtension from "../../agent/extensions/cmd-slash-tools.js";
import blockBuiltinTools from "../../agent/extensions/block-builtin-tools.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void> | void;
type SessionTreeHandler = (event: SessionTreeEvent, ctx: ExtensionContext) => Promise<void> | void;
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

let workspace: string;
const temp = useTempDir("o-pi-tool-defaults-extension-");
preserveEnv("PI_TOOLS_CONFIG", "PI_TOOLS_PROJECT_CONFIG", "PI_TOOLS_PROJECT_ROOT");

beforeEach(() => {
	workspace = temp.path;
	process.env.PI_TOOLS_CONFIG = path.join(workspace, "missing-user.jsonc");
	delete process.env.PI_TOOLS_PROJECT_CONFIG;
	delete process.env.PI_TOOLS_PROJECT_ROOT;
});

describe("/tools extension defaults", () => {
	it("没有 session 覆盖时按配置设置 active tools，缺省工具启用", async () => {
		const userPath = path.join(workspace, "user.jsonc");
		process.env.PI_TOOLS_CONFIG = userPath;
		await writeFile(userPath, '{ "bash": false, "write": false }');

		const harness = registerHarness(["read", "bash", "write", "grep"], []);
		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);

		expect(harness.activeTools).toEqual(["read", "grep"]);
	});

	it("session 中 /tools 写入的配置覆盖文件默认值", async () => {
		const userPath = path.join(workspace, "user.jsonc");
		process.env.PI_TOOLS_CONFIG = userPath;
		await writeFile(userPath, '{ "bash": false, "write": false }');

		const harness = registerHarness(["read", "bash", "write"], [
			{ type: "custom", customType: "tools-config", data: { enabledTools: ["bash"] } },
		]);
		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);

		expect(harness.activeTools).toEqual(["bash"]);
	});

	it("切换到没有 session 覆盖的分支时重新应用配置文件", async () => {
		await mkdir(path.join(workspace, ".pi"), { recursive: true });
		await writeFile(path.join(workspace, ".pi", "tools.jsonc"), '{ "grep": false }');

		const harness = registerHarness(["read", "grep", "bash"], [
			{ type: "custom", customType: "tools-config", data: { enabledTools: ["grep"] } },
		]);
		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.activeTools).toEqual(["grep"]);

		harness.branchEntries = [];
		await harness.sessionTree({ type: "session_tree", newLeafId: null, oldLeafId: null }, harness.ctx);
		expect(harness.activeTools).toEqual(["read", "bash"]);
	});
});

describe("built-in tool isolation", () => {
	it("session start 移除内置工具，并在 tool_call 阻止其恢复执行", () => {
		const tools = [
			{ ...makeToolInfo("read"), sourceInfo: { ...makeToolInfo("read").sourceInfo, source: "builtin" as const } },
			makeToolInfo("grep"),
		];
		let active = ["read", "grep"];
		const handlers = new Map<string, (event: { toolName: string }) => unknown>();
		blockBuiltinTools({
			getAllTools: () => tools,
			getActiveTools: () => active,
			setActiveTools(names: string[]) {
				active = names;
			},
			on(name: string, handler: unknown) {
				handlers.set(name, handler as (event: { toolName: string }) => unknown);
			},
		} as unknown as ExtensionAPI);

		handlers.get("session_start")?.({ toolName: "" });
		expect(active).toEqual(["grep"]);
		expect(handlers.get("tool_call")?.({ toolName: "read" })).toEqual({
			block: true,
			reason: "Pi built-in tool 'read' is disabled.",
		});
		expect(handlers.get("tool_call")?.({ toolName: "grep" })).toBeUndefined();
	});
});

function registerHarness(toolNames: string[], branchEntries: Array<{ type: "custom"; customType: string; data: unknown }>) {
	let sessionStart: SessionStartHandler | undefined;
	let sessionTree: SessionTreeHandler | undefined;
	let commandOptions: CommandOptions | undefined;
	let activeTools = [...toolNames];
	let currentBranchEntries = branchEntries;

	const pi = {
		on(event: string, handler: unknown) {
			if (event === "session_start") sessionStart = handler as SessionStartHandler;
			if (event === "session_tree") sessionTree = handler as SessionTreeHandler;
		},
		registerCommand(_name: string, options: CommandOptions) {
			commandOptions = options;
		},
		getAllTools: () => toolNames.map(makeToolInfo),
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		appendEntry() {},
	};

	toolsExtension(pi as unknown as ExtensionAPI);
	if (sessionStart === undefined) throw new Error("session_start handler not registered");
	if (sessionTree === undefined) throw new Error("session_tree handler not registered");
	if (commandOptions === undefined) throw new Error("tools command not registered");

	const ctx = {
		cwd: workspace,
		sessionManager: {
			getBranch: () => currentBranchEntries,
		},
		ui: {
			notify() {},
		},
	} as unknown as ExtensionContext;

	return {
		ctx,
		sessionStart,
		sessionTree,
		get activeTools() {
			return activeTools;
		},
		set branchEntries(entries: Array<{ type: "custom"; customType: string; data: unknown }>) {
			currentBranchEntries = entries;
		},
	};
}

function makeToolInfo(name: string): ToolInfo {
	return {
		name,
		description: name,
		parameters: { type: "object", properties: {} } as never,
		sourceInfo: {
			path: "/test/extension.ts",
			source: "test",
			scope: "temporary",
			origin: "top-level",
		},
	};
}
