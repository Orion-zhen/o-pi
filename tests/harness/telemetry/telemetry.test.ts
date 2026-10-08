import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { TelemetryService } from "../../../src/harness/telemetry/service.ts";
import type { TelemetryRecord } from "../../../src/harness/telemetry/types.ts";
import * as revision from "../../../src/harness/telemetry/revision.ts";
import { assistant } from "../../gui/transcript-fixtures.ts";
import { deferred } from "../../helpers/async.ts";
import { preserveEnv, setTestHome, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("opi-telemetry-");
preserveEnv("HOME", "USERPROFILE");
let service: TelemetryService;
let notifications: string[];
const shutdown = () => service.onSessionShutdown({ type: "session_shutdown", reason: "quit" });
beforeEach(() => {
	setTestHome(temp.path);
	notifications = [];
	service = new TelemetryService({ getAllTools: () => [], getThinkingLevel: () => "off" });
	service.onSessionStart({ type: "session_start", reason: "startup" }, {
		cwd: temp.path, sessionId: "session", notify: (message) => notifications.push(message),
	});
});
afterEach(async () => { await shutdown(); vi.restoreAllMocks(); });

function finish(id: string, parentToolCallId?: string, isError = false, durationMs?: number) {
	const parent = parentToolCallId === undefined ? {} : { parentToolCallId };
	service.onToolExecutionStart({ type: "tool_execution_start", toolCallId: id, toolName: "external", args: {}, ...parent });
	service.onToolResult({ type: "tool_result", toolCallId: id, toolName: "external", input: {}, details: {}, content: [], isError });
	service.onToolExecutionEnd({
		type: "tool_execution_end", toolCallId: id, toolName: "external", ...parent, isError,
		result: { content: [{ type: "text", text: "secret output" }], details: {} },
		...(durationMs === undefined ? {} : { durationMs }),
	});
}
async function records(): Promise<TelemetryRecord[]> {
	await shutdown();
	const directory = path.join(temp.path, ".pi/telemetry/runs");
	const [name] = await readdir(directory);
	if (!name) throw new Error("缺少遥测文件");
	const file = path.join(directory, name);
	if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
	const text = await readFile(file, "utf8");
	expect(text).not.toContain("secret output");
	return text.trim().split("\n").map((line) => JSON.parse(line) as TelemetryRecord);
}

describe("遥测收集与真实写盘", () => {
	it("没有完成的工具调用就不创建日志", async () => {
		service.onToolExecutionStart({ type: "tool_execution_start", toolCallId: "pending", toolName: "external", args: {} });
		await shutdown();
		await expect(readdir(path.join(temp.path, ".pi/telemetry/runs"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("耗时只使用 SDK 执行耗时，未执行调用不补零", async () => {
		finish("executed", undefined, false, 12.5);
		finish("zero", "executed", false, 0);
		finish("blocked", undefined, true);
		const saved = await records();
		expect(saved[1]).toMatchObject({ duration_ms: 12.5 });
		expect(saved[2]).toMatchObject({ duration_ms: 0, parent_call_id: "executed" });
		expect(saved[3]).not.toHaveProperty("duration_ms");
	});

	it("Git 采集未完成时缓存调用，写盘时先写运行头并保留完成顺序", async () => {
		const started = deferred<void>();
		const release = deferred<undefined>();
		vi.spyOn(revision, "captureGitRevision").mockImplementation(() => { started.resolve(); return release.promise; });
		finish("first");
		await started.promise;
		finish("second");
		release.resolve(undefined);
		const saved = await records();
		expect(saved.map((record) => record.type === "call" ? record.call_id : record.type)).toEqual(["run", "first", "second"]);
		expect(saved).toEqual(service.snapshot().records);
	});

	it("响应模型随轮次更新，嵌套调用继承模型并保留父 ID", async () => {
		for (const [index, model] of ["fast", "precise"].entries()) {
			service.onTurnStart({ type: "turn_start", turnIndex: index, timestamp: index }, { model: { provider: "router", id: "auto" } });
			service.onMessageEnd({ type: "message_end", message: {
				...assistant([{ type: "toolCall", id: model, name: "external", arguments: {} }]), provider: "physical", model,
			} });
			finish(model);
			finish(`${model}/1`, model);
		}
		const calls = (await records()).filter((record) => record.type === "call");
		expect(calls.map((call) => call.model?.id)).toEqual(["fast", "fast", "precise", "precise"]);
		expect(calls[0]).toMatchObject({ selected_model: { provider: "router", id: "auto" }, batch: { size: 1, index: 0 } });
		expect(calls[1]).toMatchObject({ parent_call_id: "fast" });
		expect(calls[1]).not.toHaveProperty("batch");
	});

	it("投影异常不影响工具结果，执行异常不调用结果投影", async () => {
		const result = vi.fn(() => ({ fields: { status: "failed", error_code: "NOT_FOUND" } }));
		service.registerTool({
			definition: { name: "external", description: "External tool", parameters: Type.Object({}) },
			input: () => { throw new RangeError("private input"); }, result,
		});
		finish("projected");
		finish("execution-error", undefined, true);
		const saved = await records();
		expect(saved[1]).toMatchObject({ status: "error", error: { code: "NOT_FOUND" }, fields: { telemetry_input_error: "RangeError" } });
		expect(result).toHaveBeenCalledOnce();
		expect(saved[2]).toMatchObject({ status: "error" });
	});

	it("真实写入失败只通知一次，不阻止后续工具执行", async () => {
		await mkdir(path.join(temp.path, ".pi"));
		await writeFile(path.join(temp.path, ".pi/telemetry"), "not a directory");
		finish("first");
		await shutdown();
		finish("later");
		expect(notifications).toEqual(["Telemetry disabled for this run after a write failure."]);
		expect(service.snapshot().enabled).toBe(false);
	});
});
