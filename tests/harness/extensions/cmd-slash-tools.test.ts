import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
	SessionTreeEvent,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import toolsExtension, { createToolsExtension } from "../../../src/harness/extensions/cmd-slash-tools.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

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
preserveEnv("PI_CODING_AGENT_DIR");

beforeEach(() => {
	workspace = temp.path;
	process.env.PI_CODING_AGENT_DIR = workspace;
});

describe("/tools extension defaults", () => {
	it("/tools 通过选择器回调切换会话工具并写入用户默认值", async () => {
		const userPath = path.join(workspace, "settings.json");
		const tuiModule = await import("../../../src/tui/views/tool-defaults/tool-selector.ts");
		const extension = createToolsExtension(async () => ({
			...tuiModule,
			async openToolSelector(_ui, options) {
				options.onChange("bash", true);
				await options.onPersist();
			},
		}));
		const harness = registerHarness(["read", "bash"], [], undefined, ["read"], extension);

		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);
		await harness.command.handler("", harness.ctx as never);

		expect(harness.activeTools).toEqual(["read", "bash"]);
		expect(JSON.parse(await readFile(userPath, "utf8"))).toEqual({ defaultTools: ["read", "bash"] });
	});

	it("没有会话覆盖时保留 SDK 初始工具集合", async () => {
		const harness = registerHarness(["read", "bash", "write", "grep"], [], undefined, ["read", "grep"]);
		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);

		expect(harness.activeTools).toEqual(["read", "grep"]);
	});

	it("Pi 新增的未启用内置工具不会被默认恢复流程激活", async () => {
		const harness = registerHarness(["read", "powershell"], [], undefined, ["read"]);

		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);

		expect(harness.activeTools).toEqual(["read"]);
	});

	it("会话选择覆盖 SDK 初始工具集合", async () => {
		const harness = registerHarness(["read", "bash", "write"], [
			{ type: "custom", customType: "tools-config", data: { enabledTools: ["bash"] } },
		], undefined, ["read"]);
		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);

		expect(harness.activeTools).toEqual(["bash"]);
		await harness.selectModel("openai-codex", "gpt-5.3-codex");
		expect(harness.activeTools).toEqual(["bash"]);
	});

	it("切换模型不重新应用默认值，也不覆盖 SDK 的实时工具选择", async () => {
		const harness = registerHarness(["read", "websearch", "webfetch"], [], makeModel("local", "qwen3-coder"));
		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);
		harness.setActiveTools(["webfetch"]);
		await harness.selectModel("openai-codex", "gpt-5.3-codex");
		expect(harness.activeTools).toEqual(["webfetch"]);
	});

	it("切换到没有会话覆盖的分支时恢复 SDK 初始工具集合", async () => {
		const harness = registerHarness(["read", "grep", "bash"], [
			{ type: "custom", customType: "tools-config", data: { enabledTools: ["grep"] } },
		], undefined, ["read", "bash"]);
		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.activeTools).toEqual(["grep"]);

		harness.branchEntries = [];
		await harness.sessionTree({ type: "session_tree", newLeafId: null, oldLeafId: null }, harness.ctx);
		expect(harness.activeTools).toEqual(["read", "bash"]);
	});

	it("扩展不重复读取默认设置，避免覆盖 SDK 已解析的初始集合", async () => {
		const userPath = path.join(workspace, "settings.json");
		const harness = registerHarness(["read", "grep"], [], undefined, ["read"]);
		await harness.sessionStart({ type: "session_start", reason: "startup" }, harness.ctx);
		expect(harness.activeTools).toEqual(["read"]);

		await writeFile(userPath, '{ "defaultTools": ["read", "grep"] }');
		harness.branchEntries = [{ type: "custom", customType: "tools-config", data: { enabledTools: ["read"] } }];
		await harness.sessionTree({ type: "session_tree", newLeafId: null, oldLeafId: null }, harness.ctx);

		harness.branchEntries = [];
		await harness.sessionTree({ type: "session_tree", newLeafId: null, oldLeafId: null }, harness.ctx);
		expect(harness.activeTools).toEqual(["read"]);
	});
});

function registerHarness(
	toolNames: string[],
	branchEntries: Array<{ type: "custom"; customType: string; data: unknown }>,
	initialModel?: Model<Api>,
	initialActiveTools: string[] = toolNames,
	extension: (pi: ExtensionAPI) => void = toolsExtension,
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

	extension(pi as unknown as ExtensionAPI);
	if (sessionStart === undefined) throw new Error("session_start handler not registered");
	if (sessionTree === undefined) throw new Error("session_tree handler not registered");
	if (commandOptions === undefined) throw new Error("tools command not registered");
	const handleModelSelect = modelSelect;

	const ctx = {
		cwd: workspace,
		mode: "tui",
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
		command: commandOptions,
		setActiveTools: pi.setActiveTools,
		sessionStart,
		sessionTree,
		async selectModel(provider: string, id: string) {
			const previousModel = ctx.model;
			const model = makeModel(provider, id);
			ctx.model = model;
			await handleModelSelect?.({ type: "model_select", model, previousModel, source: "set" }, ctx);
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
		exposure: "direct",
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
