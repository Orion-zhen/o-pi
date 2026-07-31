import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import approvalGateExtension from "../../agent/extensions/approval-gate.js";
import { defaultApprovalGateConfig } from "../../src/approval/config.js";
import {
	createApprovalGate,
	type ApprovalContext,
	type ApprovalGateOptions,
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
	it.each([
		["普通 bash", () => bash("echo hello"), [], 0],
		["普通 edit", () => edit("src/index.ts"), [], 0],
		["需审批 write", () => write(systemPath("etc", "hosts")), ["Allow once"], 1],
	] as const)("%s 放行并产生预期交互", async (_name, event, choices, selectCalls) => {
		const ui = fakeUi([...choices]);
		expect(await handle(event(), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(selectCalls);
	});

	it.each([
		["用户拒绝", ["Deny"], true, undefined],
		["用户附带指令拒绝", ["Deny with instruction"], true, "open a PR instead"],
		["无 UI", [], false, undefined],
	] as const)("%s 时 fail closed", async (_name, choices, interactive, instruction) => {
		const ui = fakeUi([...choices], instruction);
		const result = await handle(bash("git push origin main"), ctx(ui, interactive));
		expect(result?.block).toBe(true);
		expect(ui.selectCalls).toBe(interactive ? 1 : 0);
		if (instruction) expect(result?.reason).toContain(instruction);
	});

	it("ask allow once 记录结构化 telemetry", async () => {
		const ui = fakeUi(["Allow once"]);
		const observations: ApprovalTelemetry[] = [];
		const gate = testGate({
			telemetry(_toolCallId, _toolName, approval) {
				observations.push(approval);
			},
		});
		expect(await gate.handleToolCall(bash("git push origin main"), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(1);
		expect(observations).toContainEqual(expect.objectContaining({
			decision: "ask",
			outcome: "allow_once",
			wait_ms: expect.any(Number),
		}));
	});

	it("窄 interaction port 可完成审批", async () => {
		const interaction: ApprovalInteractionPort = {
			select: async () => "Allow once",
			input: async () => undefined,
			notify() {},
		};
		expect(await testGate().handleToolCall(bash("git push origin main"), {
			cwd: dir,
			interaction,
		})).toBeUndefined();
	});

	it("ask 在选择前通知用户", async () => {
		const order: string[] = [];
		const ui = fakeUi(["Allow once"], undefined, () => order.push("select"));
		const gate = testGate({
			notifyUser: async () => {
				order.push("notify");
			},
		});
		expect(await gate.handleToolCall(bash("git push origin main"), ctx(ui))).toBeUndefined();
		expect(order).toEqual(["notify", "select"]);
	});

	it("通知失败不阻塞审批", async () => {
		const ui = fakeUi(["Allow once"]);
		const gate = testGate({
			notifyUser: async () => {
				throw new Error("notification unavailable");
			},
		});
		expect(await gate.handleToolCall(bash("git push origin main"), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(1);
	});

	it("复合命令只触发一次聚合审批", async () => {
		const ui = fakeUi(["Allow once"]);
		expect(await handle(bash("git push origin main && npm install lodash"), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(1);
	});

	it("session allow 记住敏感子命令，不受普通 sibling 变化影响", async () => {
		const ui = fakeUi(["Allow for session"]);
		const gate = testGate();
		expect(await gate.handleToolCall(bash("echo first && git push origin main"), ctx(ui))).toBeUndefined();
		expect(await gate.handleToolCall(bash("echo changed && git push origin main"), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(1);
	});

	it("always similar 只覆盖对应子命令，不吞掉 compound suffix", async () => {
		const ui = fakeUi(["Always allow similar", "Allow once"]);
		const gate = testGate();
		expect(await gate.handleToolCall(bash("npm install lodash"), ctx(ui))).toBeUndefined();
		expect(await gate.handleToolCall(bash("npm install react && git push origin main"), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(2);
	});

	it("无法安全记忆的动态写重定向只提供一次性审批", async () => {
		const ui = fakeUi(["Allow once"]);
		expect(await handle(bash(`echo value > "$OUTPUT"`), ctx(ui))).toBeUndefined();
		expect(ui.selectOptions[0]).toHaveLength(3);
		expect(ui.selectOptions[0]).toEqual(expect.arrayContaining(["Allow once", "Deny", "Deny with instruction"]));
	});

	it.each([
		["mktemp 临时目录中的写入与清理", `
set -eu
root="$PWD"
tmpdir=$(mktemp -d)
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT
cat > "$tmpdir/input.txt" <<'EOF'
content
EOF
for engine in xelatex lualatex; do
	(cd "$tmpdir" && TOOL_INPUT="$root//:" "$engine" input.txt > result.txt)
done
rm -f "$tmpdir/result.txt"
`],
		["系统临时目录后代的递归清理", `rm -rf "${path.join(os.tmpdir(), "pi-approval", "work")}"`],
	] as const)("%s 不触发审批", async (_name, command) => {
		const ui = fakeUi([]);
		expect(await handle(bash(command), ctx(ui))).toBeUndefined();
		expect(ui.selectCalls).toBe(0);
	});

	it("UI 返回未提供的 remembered 选项时 fail closed", async () => {
		const ui = fakeUi(["Allow for session"]);
		expect(await handle(bash(`echo value > "$OUTPUT"`), ctx(ui))).toMatchObject({ block: true });
		expect(ui.selectCalls).toBe(1);
	});

	it("config disabled 时 extension handler 放行", async () => {
		const configPath = path.join(dir, "approval.jsonc");
		await writeFile(configPath, '{ "enabled": false }');
		process.env.PI_APPROVAL_GATE_CONFIG = configPath;
		const handler = captureExtensionHandler();
		expect(await handler(bash("git push origin main"), extensionCtx(fakeUi([])))).toBeUndefined();
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

function testGate(options: ApprovalGateOptions = {}) {
	return createApprovalGate({
		loadConfig: async () => testConfig(),
		store: new FileApprovalStore(path.join(dir, "rules.jsonc")),
		notifyUser: async () => {},
		...options,
	});
}

function testConfig(): ApprovalGateConfig {
	const config = defaultApprovalGateConfig();
	return {
		...config,
		remember: { ...config.remember, persistent_store: path.join(dir, "approval.rules.jsonc") },
	};
}

function handle(event: ToolCallEvent, context: ApprovalContext): Promise<ToolCallEventResult | void> {
	return testGate().handleToolCall(event, context);
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

interface FakeUi {
	selectCalls: number;
	selectOptions: string[][];
	select(title: string, options: string[]): Promise<string | undefined>;
	input(): Promise<string | undefined>;
	notify(): void;
}

function fakeUi(choices: string[], instruction?: string, onSelect?: () => void): FakeUi {
	return {
		selectCalls: 0,
		selectOptions: [],
		async select(_title: string, options: string[]) {
			this.selectCalls += 1;
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
