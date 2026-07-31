import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import approvalGateExtension from "../../agent/extensions/approval-gate.js";
import { defaultApprovalGateConfig } from "../../src/approval/config.js";
import {
	createApprovalGate,
	type ApprovalContext,
	type ApprovalInteractionPort,
} from "../../src/approval/gate.js";
import { FileApprovalStore } from "../../src/approval/store.js";
import type { ApprovalGateConfig, ApprovalTelemetry } from "../../src/approval/types.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

let dir: string;
const temp = useTempDir("o-pi-approval-gate-");
preserveEnv("PI_APPROVAL_GATE_CONFIG", "PI_FILE_TOOLS_CONFIG");

beforeEach(() => {
	dir = temp.path;
	delete process.env.PI_APPROVAL_GATE_CONFIG;
	delete process.env.PI_FILE_TOOLS_CONFIG;
});

describe("approval gate", () => {
	it("普通 bash echo hello 不弹窗，return undefined", async () => {
		const ui = fakeUi([]);
		const result = await handle(bash("echo hello"), ctx(ui));
		expect(result).toBeUndefined();
		expect(ui.selectCalls).toBe(0);
	});

	it("git push 命中 ask，用户 Allow once 后 return undefined", async () => {
		const ui = fakeUi(["Allow once"]);
		const event = bash("git push origin main");
		const observations: ApprovalTelemetry[] = [];
		const gate = createApprovalGate({
			loadConfig: async () => configWith({}),
			store: new FileApprovalStore(path.join(dir, "rules.jsonc")),
			notifyUser: async () => {},
			telemetry(_toolCallId, _toolName, approval) {
				observations.push(approval);
			},
		});
		expect(await gate.handleToolCall(event, ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(1);
		expect(observations).toContainEqual(expect.objectContaining({
			decision: "ask",
			outcome: "allow_once",
			wait_ms: expect.any(Number),
		}));
	});

	it("RPC dialog adapter 可通过窄 interaction port 完成审批", async () => {
		const choices = ["Allow once"];
		const interaction: ApprovalInteractionPort = {
			select: async () => choices.shift(),
			input: async () => undefined,
			notify() {},
		};
		const gate = createApprovalGate({
			loadConfig: async () => configWith({}),
			store: new FileApprovalStore(path.join(dir, "rules.jsonc")),
			notifyUser: async () => {},
		});

		expect(await gate.handleToolCall(bash("git push origin main"), {
			cwd: dir,
			interaction,
		})).toBeUndefined();
	});

	it("ask 会在打开审批选择前通知用户", async () => {
		const order: string[] = [];
		const ui = fakeUi(["Allow once"], undefined, () => order.push("select"));
		const gate = createApprovalGate({
			loadConfig: async () => configWith({}),
			store: new FileApprovalStore(path.join(dir, "rules.jsonc")),
			notifyUser: async () => {
				order.push("notify");
			},
		});

		expect(await gate.handleToolCall(bash("git push origin main"), ctx(ui))).toBeUndefined();
		expect(order).toEqual(["notify", "select"]);
	});

	it("通知失败不阻塞审批", async () => {
		const ui = fakeUi(["Allow once"]);
		const gate = createApprovalGate({
			loadConfig: async () => configWith({}),
			store: new FileApprovalStore(path.join(dir, "rules.jsonc")),
			notifyUser: async () => {
				throw new Error("notification unavailable");
			},
		});

		expect(await gate.handleToolCall(bash("git push origin main"), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(1);
	});

	it("git push 命中 ask，用户 Deny 后返回 block", async () => {
		const result = await handle(bash("git push origin main"), ctx(fakeUi(["Deny"])));
		expect(result).toEqual({ block: true, reason: "User denied this tool call." });
	});

	it("git push 命中 ask，用户 Deny with instruction 后返回 block 且包含 instruction", async () => {
		const result = await handle(bash("git push origin main"), ctx(fakeUi(["Deny with instruction"], "open a PR instead")));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Instruction from user:");
		expect(result?.reason).toContain("open a PR instead");
	});

	it("用户 Allow for session 后，第二次相同请求不弹窗", async () => {
		const ui = fakeUi(["Allow for session"]);
		const config = configWith({ remember: { ...defaultApprovalGateConfig().remember, allow_persistent: false } });
		const gate = createApprovalGate({
			loadConfig: async () => config,
			store: new FileApprovalStore(path.join(dir, "rules.jsonc")),
			notifyUser: async () => {},
		});
		expect(await gate.handleToolCall(bash("git push origin main"), ctx(ui))).toBeUndefined();
		expect(await gate.handleToolCall(bash("git push origin main"), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(1);
	});

	it("复合命令只弹一个聚合审批框", async () => {
		const ui = fakeUi(["Allow once"]);
		expect(await handle(bash("git push origin main && npm install lodash"), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(1);
		expect(ui.selectTitles[0]).toContain("1. git push origin main");
		expect(ui.selectTitles[0]).toContain("2. npm install lodash");
	});

	it("session allow 记住敏感子命令，不受普通 sibling 变化影响", async () => {
		const ui = fakeUi(["Allow for session"]);
		const gate = createApprovalGate({
			loadConfig: async () => configWith({}),
			store: new FileApprovalStore(path.join(dir, "rules.jsonc")),
			notifyUser: async () => {},
		});
		expect(await gate.handleToolCall(bash("echo first && git push origin main"), ctx(ui))).toBeUndefined();
		expect(await gate.handleToolCall(bash("echo changed && git push origin main"), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(1);
	});

	it("always similar 只覆盖对应子命令，不吞掉 compound suffix", async () => {
		const ui = fakeUi(["Always allow similar", "Allow once"]);
		const gate = createApprovalGate({
			loadConfig: async () => configWith({}),
			store: new FileApprovalStore(path.join(dir, "rules.jsonc")),
			notifyUser: async () => {},
		});
		expect(await gate.handleToolCall(bash("npm install lodash"), ctx(ui))).toBeUndefined();
		expect(await gate.handleToolCall(bash("npm install react && git push origin main"), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(2);
		expect(ui.selectTitles[1]).toContain("1. git push origin main");
		expect(ui.selectTitles[1]).not.toContain("2. npm install react");
	});

	it("动态写重定向无法安全记忆时只显示一次性批准", async () => {
		const ui = fakeUi(["Allow once"]);
		expect(await handle(bash(`echo value > "$OUTPUT"`), ctx(ui))).toBeUndefined();
		expect(ui.selectOptions[0]).toEqual(["Allow once", "Deny", "Deny with instruction"]);
	});

	it("UI 返回未提供的 remembered 选项时 fail closed", async () => {
		const ui = fakeUi(["Allow for session"]);
		expect(await handle(bash(`echo value > "$OUTPUT"`), ctx(ui))).toEqual({
			block: true,
			reason: "User denied this tool call.",
		});
	});

	it("没有 UI 时，ask 请求默认 block", async () => {
		const result = await handle(bash("git push origin main"), ctx(fakeUi([]), false));
		expect(result).toMatchObject({ block: true, reason: expect.stringContaining("no interactive UI") });
	});

	it("config disabled 时所有请求通过 extension handler 放行", async () => {
		const configPath = path.join(dir, "approval.jsonc");
		await writeFile(configPath, '{ "enabled": false }');
		process.env.PI_APPROVAL_GATE_CONFIG = configPath;
		const handler = captureExtensionHandler();
		expect(await handler(bash("git push origin main"), extensionCtx(fakeUi(["Deny"])))).toBeUndefined();
	});

	it("write /etc/hosts 命中 ask", async () => {
		const ui = fakeUi(["Allow once"]);
		expect(await handle(write(systemPath("etc", "hosts")), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(1);
	});

	it("edit 普通文件默认放行", async () => {
		const ui = fakeUi([]);
		expect(await handle(edit("src/index.ts"), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(0);
	});

	it("write preflight 使用 filesystem access policy 拒绝 blocked path", async () => {
		const configPath = path.join(dir, "file-tools.jsonc");
		await writeFile(configPath, JSON.stringify({ blocked_path: ["private/"] }));
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		const result = await handle(write("private/data.txt"), ctx(fakeUi([])));
		expect(result).toMatchObject({
			block: true,
			reason: expect.stringContaining("Matched path rule: private/"),
		});
	});
});

function systemPath(...segments: string[]): string {
	return path.join(path.parse(dir).root, ...segments);
}

async function handle(event: ToolCallEvent, context: ApprovalContext): Promise<ToolCallEventResult | void> {
	const config = configWith({});
	const gate = createApprovalGate({
		loadConfig: async () => config,
		store: new FileApprovalStore(path.join(dir, "rules.jsonc")),
		notifyUser: async () => {},
	});
	return gate.handleToolCall(event, context);
}

function captureExtensionHandler(): (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void> {
	let captured: ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void) | undefined;
	const on = ((event: "tool_call", handler: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void) => {
		if (event === "tool_call") captured = handler;
	}) as Pick<ExtensionAPI, "on">["on"];
	approvalGateExtension({ on } as ExtensionAPI);
	if (captured === undefined) throw new Error("tool_call handler not registered");
	return async (event, context) => captured?.(event, context);
}

function configWith(patch: Partial<ApprovalGateConfig>): ApprovalGateConfig {
	return {
		...defaultApprovalGateConfig(),
		remember: { ...defaultApprovalGateConfig().remember, persistent_store: path.join(dir, "approval.rules.jsonc") },
		...patch,
	};
}

interface FakeUi {
	selectCalls: number;
	selectTitles: string[];
	selectOptions: string[][];
	select(title: string, options: string[]): Promise<string | undefined>;
	input(): Promise<string | undefined>;
	notify(): void;
}

function fakeUi(choices: string[], instruction?: string, onSelect?: () => void): FakeUi {
	return {
		selectCalls: 0,
		selectTitles: [],
		selectOptions: [],
		async select(title: string, options: string[]) {
			this.selectCalls += 1;
			this.selectTitles.push(title);
			this.selectOptions.push([...options]);
			onSelect?.();
			return choices.shift();
		},
		async input() {
			return instruction;
		},
		notify() {},
	};
}

function ctx(ui: FakeUi, interactive = true): ApprovalContext {
	return {
		cwd: dir,
		...(interactive ? { interaction: ui } : {}),
	};
}

function extensionCtx(ui: FakeUi): ExtensionContext {
	return { cwd: dir, hasUI: true, ui } as never;
}

function bash(command: string): ToolCallEvent {
	return { type: "tool_call", toolName: "bash", toolCallId: `bash-${command}`, input: { command } };
}

function write(filePath: string): ToolCallEvent {
	return { type: "tool_call", toolName: "write", toolCallId: `write-${filePath}`, input: { path: filePath, content: "x" } };
}

function edit(filePath: string): ToolCallEvent {
	return { type: "tool_call", toolName: "edit", toolCallId: `edit-${filePath}`, input: { path: filePath, edits: [{ old: "a", new: "b" }] } };
}
