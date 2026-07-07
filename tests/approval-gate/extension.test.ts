import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import approvalGateExtension from "../../agent/extensions/approval-gate.js";
import { defaultApprovalGateConfig } from "../../src/approval/config.js";
import { createApprovalGate } from "../../src/approval/gate.js";
import { FileApprovalStore } from "../../src/approval/store.js";
import type { ApprovalGateConfig } from "../../src/approval/types.js";

let dir: string;
const previousApprovalConfig = process.env.PI_APPROVAL_GATE_CONFIG;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "o-pi-approval-gate-"));
	delete process.env.PI_APPROVAL_GATE_CONFIG;
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
	if (previousApprovalConfig === undefined) delete process.env.PI_APPROVAL_GATE_CONFIG;
	else process.env.PI_APPROVAL_GATE_CONFIG = previousApprovalConfig;
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
		expect(await handle(bash("git push origin main"), ctx(ui))).toBeUndefined();
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
		const gate = createApprovalGate({ loadConfig: async () => config, store: new FileApprovalStore(path.join(dir, "rules.jsonc")) });
		expect(await gate.handleToolCall(bash("git push origin main"), ctx(ui))).toBeUndefined();
		expect(await gate.handleToolCall(bash("git push origin main"), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(1);
	});

	it("没有 UI 时，ask 请求默认 block", async () => {
		const result = await handle(bash("git push origin main"), ctx(fakeUi([]), false));
		expect(result).toMatchObject({ block: true, reason: expect.stringContaining("no interactive UI") });
	});

	it("config disabled 时所有请求通过 extension handler 放行", async () => {
		const configPath = path.join(dir, "approval.jsonc");
		await writeFile(configPath, '{ "version": 1, "enabled": false }');
		process.env.PI_APPROVAL_GATE_CONFIG = configPath;
		const handler = captureExtensionHandler();
		expect(await handler(bash("git push origin main"), ctx(fakeUi(["Deny"])))).toBeUndefined();
	});

	it("write /etc/hosts 命中 ask", async () => {
		const ui = fakeUi(["Allow once"]);
		expect(await handle(write("/etc/hosts"), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(1);
	});

	it("edit 普通文件默认放行", async () => {
		const ui = fakeUi([]);
		expect(await handle(edit("src/index.ts"), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(0);
	});
});

async function handle(event: ToolCallEvent, context: ExtensionContext): Promise<ToolCallEventResult | void> {
	const config = configWith({});
	const gate = createApprovalGate({ loadConfig: async () => config, store: new FileApprovalStore(path.join(dir, "rules.jsonc")) });
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
	select(title: string, options: string[]): Promise<string | undefined>;
	input(): Promise<string | undefined>;
	notify(): void;
}

function fakeUi(choices: string[], instruction?: string): FakeUi {
	return {
		selectCalls: 0,
		async select(_title: string, _options: string[]) {
			this.selectCalls += 1;
			return choices.shift();
		},
		async input() {
			return instruction;
		},
		notify() {},
	};
}

function ctx(ui: FakeUi, hasUI = true): ExtensionContext {
	return { cwd: dir, hasUI, ui } as never;
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
