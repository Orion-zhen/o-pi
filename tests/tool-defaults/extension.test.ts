import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
	SessionTreeEvent,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import toolsExtension from "../../agent/extensions/cmd-slash-tools.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void> | void;
type SessionTreeHandler = (event: SessionTreeEvent, ctx: ExtensionContext) => Promise<void> | void;
type ModelSelectHandler = (
	event: {
		type: "model_select";
		model: Model<Api>;
		previousModel: Model<Api> | undefined;
		source: "set" | "cycle" | "restore";
	},
	ctx: ExtensionContext,
) => Promise<void> | void;
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
	it("没有 session 覆盖时按配置设置 active tools，缺省工具继承宿主状态", async () => {
		const userPath = path.join(workspace, "user.jsonc");
		process.env.PI_TOOLS_CONFIG = userPath;
		await writeFile(userPath, '{ "defaults": { "bash": false, "write": false } }');

		const harness = registerHarness(["read", "bash", "write", "grep"], []);
		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);

		expect(harness.activeTools).toEqual(["read", "grep"]);
	});

	it("Pi 新增的未启用内置工具不会被默认恢复流程激活", async () => {
		const harness = registerHarness(["read", "powershell"], [], undefined, ["read"]);

		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);

		expect(harness.activeTools).toEqual(["read"]);
	});

	it("session 中 /tools 写入的配置覆盖文件默认值", async () => {
		const userPath = path.join(workspace, "user.jsonc");
		process.env.PI_TOOLS_CONFIG = userPath;
		await writeFile(userPath, '{ "defaults": { "bash": false, "write": false } }');

		const harness = registerHarness(["read", "bash", "write"], [
			{ type: "custom", customType: "tools-config", data: { enabledTools: ["bash"] } },
		]);
		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);

		expect(harness.activeTools).toEqual(["bash"]);
		await harness.selectModel("openai-codex", "gpt-5.3-codex");
		expect(harness.activeTools).toEqual(["bash"]);
	});

	it("没有 session 覆盖时在 model_select 后重新应用匹配规则", async () => {
		const userPath = path.join(workspace, "user.jsonc");
		process.env.PI_TOOLS_CONFIG = userPath;
		await writeFile(
			userPath,
			`{
				"rules": [
					{
						"match": "openai-codex/*",
						"tools": { "websearch": false, "webfetch": false }
					}
				]
			}`,
		);

		const harness = registerHarness(
			["read", "websearch", "webfetch"],
			[],
			makeModel("local", "qwen3-coder"),
		);
		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.activeTools).toEqual(["read", "websearch", "webfetch"]);

		await harness.selectModel("openai-codex", "gpt-5.3-codex");
		expect(harness.activeTools).toEqual(["read"]);
	});

	it("切换到没有 session 覆盖的分支时重新应用配置文件", async () => {
		await mkdir(path.join(workspace, ".pi"), { recursive: true });
		await writeFile(path.join(workspace, ".pi", "tools.jsonc"), '{ "defaults": { "grep": false } }');

		const harness = registerHarness(["read", "grep", "bash"], [
			{ type: "custom", customType: "tools-config", data: { enabledTools: ["grep"] } },
		]);
		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.activeTools).toEqual(["grep"]);

		harness.branchEntries = [];
		await harness.sessionTree({ type: "session_tree", newLeafId: null, oldLeafId: null }, harness.ctx);
		expect(harness.activeTools).toEqual(["read", "bash"]);
	});

	it("分支恢复即使命中 session 覆盖也会失效配置缓存", async () => {
		const userPath = path.join(workspace, "user.jsonc");
		process.env.PI_TOOLS_CONFIG = userPath;
		await writeFile(userPath, '{ "defaults": { "grep": false } }');

		const harness = registerHarness(["read", "grep"], []);
		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.activeTools).toEqual(["read"]);

		await writeFile(userPath, '{ "defaults": { "grep": true } }');
		harness.branchEntries = [{ type: "custom", customType: "tools-config", data: { enabledTools: ["read"] } }];
		await harness.sessionTree({ type: "session_tree", newLeafId: null, oldLeafId: null }, harness.ctx);

		harness.branchEntries = [];
		await harness.selectModel("local", "qwen3-coder");
		expect(harness.activeTools).toEqual(["read", "grep"]);
	});
});

function registerHarness(
	toolNames: string[],
	branchEntries: Array<{ type: "custom"; customType: string; data: unknown }>,
	initialModel?: Model<Api>,
	initialActiveTools: string[] = toolNames,
) {
	let sessionStart: SessionStartHandler | undefined;
	let sessionTree: SessionTreeHandler | undefined;
	let modelSelect: ModelSelectHandler | undefined;
	let commandOptions: CommandOptions | undefined;
	let activeTools = [...initialActiveTools];
	let currentBranchEntries = branchEntries;

	const pi = {
		on(event: string, handler: unknown) {
			if (event === "session_start") sessionStart = handler as SessionStartHandler;
			if (event === "session_tree") sessionTree = handler as SessionTreeHandler;
			if (event === "model_select") modelSelect = handler as ModelSelectHandler;
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
	if (modelSelect === undefined) throw new Error("model_select handler not registered");
	if (commandOptions === undefined) throw new Error("tools command not registered");
	const handleModelSelect = modelSelect;

	const ctx = {
		cwd: workspace,
		sessionManager: {
			getBranch: () => currentBranchEntries,
		},
		ui: {
			notify() {},
		},
		model: initialModel,
	} as unknown as ExtensionContext;

	return {
		ctx,
		sessionStart,
		sessionTree,
		async selectModel(provider: string, id: string) {
			const previousModel = ctx.model;
			const model = makeModel(provider, id);
			ctx.model = model;
			await handleModelSelect({ type: "model_select", model, previousModel, source: "set" }, ctx);
		},
		get activeTools() {
			return activeTools;
		},
		set branchEntries(entries: Array<{ type: "custom"; customType: string; data: unknown }>) {
			currentBranchEntries = entries;
		},
	};
}

function makeModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://localhost/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	};
}

function makeToolInfo(name: string): ToolInfo {
	return {
		name,
		description: name,
		parameters: { type: "object", properties: {} } as never,
		sourceInfo: {
			path: path.resolve("test", "extension.ts"),
			source: "test",
			scope: "temporary",
			origin: "top-level",
		},
	};
}
