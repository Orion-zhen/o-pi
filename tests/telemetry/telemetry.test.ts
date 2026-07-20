import {
	createEventBus,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionStartEvent,
	type ToolDefinition,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { loadExtensions } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { registerTelemetryCommand } from "../../agent/extensions/telemetry.js";
import { defineToolTelemetry, fields } from "../../src/telemetry/projection.js";
import { registerTelemetry, TelemetryService, telemetryServiceFor } from "../../src/telemetry/service.js";
import { registerObservedTool } from "../../src/telemetry/tool.js";
import type { CallRecord, GitRevision, TelemetryRecord } from "../../src/telemetry/types.js";
import type { TelemetryWriter, TelemetryWriterStatus } from "../../src/telemetry/writer.js";

const parameters = Type.Object({ path: Type.String(), count: Type.Optional(Type.Integer()) }, { additionalProperties: false });
interface TestDetails { status: string; error_code?: string; truncated?: boolean }
type TestTool = ToolDefinition<typeof parameters, TestDetails, unknown>;

describe("telemetry service", () => {
	it("shares one collector per Pi runtime and attaches only seven public hooks", () => {
		const events = createEventBus();
		const firstPi = fakePi(events);
		const secondPi = fakePi(events);
		const first = registerTelemetry(firstPi.api);
		const second = telemetryServiceFor(secondPi.api);
		expect(second).toBe(first);
		expect(firstPi.hooks).toEqual([
			"session_start", "turn_start", "message_end", "tool_execution_start", "tool_result", "tool_execution_end", "session_shutdown",
		]);
		expect(secondPi.hooks).toEqual([]);
	});

	it("independently loaded extensions still attach one collector", async () => {
		const loaded = await loadExtensions([
			fileURLToPath(new URL("../../agent/extensions/bash-tool.ts", import.meta.url)),
			fileURLToPath(new URL("../../agent/extensions/subagent.ts", import.meta.url)),
			fileURLToPath(new URL("../../agent/extensions/telemetry.ts", import.meta.url)),
		], process.cwd(), createEventBus());
		expect(loaded.errors).toEqual([]);
		for (const event of ["session_start", "turn_start", "message_end", "tool_execution_start", "tool_result", "tool_execution_end", "session_shutdown"] as const) {
			const handlers = loaded.extensions.reduce((count, extension) => count + (extension.handlers.get(event)?.length ?? 0), 0);
			expect(handlers, event).toBe(event === "tool_result" ? 3 : 1);
		}
		const telemetry = loaded.extensions.find((extension) => extension.path.endsWith("agent/extensions/telemetry.ts"));
		expect(telemetry?.commands.has("telemetry")).toBe(true);
	});

	it("writes one run header and one completed, projected call", async () => {
		const writer = new MemoryWriter();
		let inputProjectionCalls = 0;
		let mutationBlocked = false;
		let monotonic = 100;
		const pi = fakePi().api;
		const service = new TelemetryService(pi, {
			runId: () => "run-1",
			now: clock(),
			monotonicNow: () => monotonic,
			revision: async (): Promise<GitRevision> => ({ commit: "abc", dirty: false }),
			writerFactory: async () => writer,
		});
		service.registerTool(testTool(), defineToolTelemetry({
			input: (params: { path: string; count?: number }) => {
				inputProjectionCalls += 1;
				try { params.path = "mutated"; } catch { mutationBlocked = true; }
				return { fields: { input_count: params.count ?? 0 }, targets: [{ kind: "file", value: params.path }] };
			},
			result: (_params, result) => ({ fields: fields({ status: result.details.status, error_code: result.details.error_code, truncated: result.details.truncated }) }),
		}));
		const ctx = extensionContext();
		await service.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
		service.onTurnStart({ type: "turn_start", turnIndex: 2, timestamp: 1 }, ctx);
		service.onMessageEnd(fixture({ type: "message_end", message: assistantCalls(["call-1", "call-2"]) }));
		service.onToolExecutionStart({ type: "tool_execution_start", toolCallId: "call-1", toolName: "test", args: { path: "raw.ts", count: "3" } });
		service.prepared({ toolName: "test", rawArgs: fixture({ path: "raw.ts" }), preparedArgs: { path: "src/a.ts", count: 3 }, status: "repaired", operations: ["numeric_string_to_number"] });
		service.onToolResult(fixture<ToolResultEvent>({ type: "tool_result", toolCallId: "call-1", toolName: "test", input: { path: "src/a.ts", count: 3 }, details: { status: "ok" }, content: [], isError: false }));
		monotonic = 125;
		service.onToolExecutionEnd({ type: "tool_execution_end", toolCallId: "call-1", toolName: "test", result: result({ status: "ok", truncated: true }), isError: false });

		expect(writer.records[0]).toMatchObject({ type: "run", run_id: "run-1", git: { commit: "abc", dirty: false } });
		expect(writer.records[1]).toMatchObject({
			type: "call",
			call_id: "call-1",
			turn_index: 2,
			tool: "test",
			model: { provider: "test-provider", id: "test-model" },
			repo_map: { enabled: false },
			duration_ms: 25,
			status: "success",
			truncated: true,
			batch: { size: 2, index: 0 },
			repair: { status: "repaired", operations: ["numeric_string_to_number"] },
			fields: { input_count: 3, status: "ok", truncated: true },
			targets: [{ kind: "file", value: "src/a.ts" }],
		});
		expect((writer.records[1] as CallRecord).definition_hash).toMatch(/^[a-f0-9]{64}$/u);
		expect(inputProjectionCalls).toBe(1);
		expect(mutationBlocked).toBe(true);
		const snapshot = service.snapshot();
		expect(snapshot).toMatchObject({
			run_id: "run-1",
			session_id: "session-1",
			enabled: true,
			pending_calls: 0,
			records: [{ type: "run" }, { type: "call", call_id: "call-1" }],
		});
		snapshot.records.length = 0;
		expect(service.snapshot().records).toHaveLength(2);
	});

	it("buffers calls in order while startup resources initialize", async () => {
		const writer = new MemoryWriter();
		const writerGate = deferred<TelemetryWriter>();
		const revisionGate = deferred<GitRevision | undefined>();
		const service = new TelemetryService(fakePi().api, {
			runId: () => "run",
			writerFactory: async () => writerGate.promise,
			revision: async () => revisionGate.promise,
		});
		const initialization = service.onSessionStart({ type: "session_start", reason: "startup" }, extensionContext());
		service.onToolExecutionStart({ type: "tool_execution_start", toolCallId: "early", toolName: "host", args: {} });
		service.onToolExecutionEnd({ type: "tool_execution_end", toolCallId: "early", toolName: "host", result: result({ status: "ok" }), isError: false });
		expect(writer.records).toEqual([]);
		writerGate.resolve(writer);
		revisionGate.resolve(undefined);
		await initialization;
		expect(writer.records.map((record) => record.type)).toEqual(["run", "call"]);
		expect(writer.records[1]).toMatchObject({ call_id: "early" });
	});

	it("does not put telemetry initialization on Pi's session_start await chain", async () => {
		let start: ((event: SessionStartEvent, ctx: ExtensionContext) => unknown) | undefined;
		const writerGate = deferred<TelemetryWriter>();
		const revisionGate = deferred<GitRevision | undefined>();
		const pi = fakePi().api;
		pi.on = (event, handler) => {
			if (event === "session_start") start = fixture<(event: SessionStartEvent, ctx: ExtensionContext) => unknown>(handler);
		};
		const service = new TelemetryService(pi, {
			runId: () => "run",
			writerFactory: async () => writerGate.promise,
			revision: async () => revisionGate.promise,
		});
		service.attach(pi);
		if (start === undefined) throw new Error("session_start not attached");
		expect(start({ type: "session_start", reason: "startup" }, extensionContext())).toBeUndefined();
		writerGate.resolve(new MemoryWriter());
		revisionGate.resolve(undefined);
		await service.onSessionShutdown({ type: "session_shutdown", reason: "quit" });
	});

	it("registers a non-TUI live report without writing to session history", async () => {
		let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
		const notifications: string[] = [];
		registerTelemetryCommand({
			registerCommand(name, options) {
				expect(name).toBe("telemetry");
				command = options;
			},
		}, {
			snapshot: () => ({ enabled: false, pending_calls: 0, records: [] }),
		});
		if (command === undefined) throw new Error("telemetry command not registered");
		await command.handler("", fixture({
			mode: "print",
			ui: { notify(message: string) { notifications.push(message); } },
		}));
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toContain("Telemetry · current session");
		expect(notifications[0]).toContain("collection disabled");

		let customCalled = false;
		await command.handler("", fixture({
			mode: "tui",
			ui: {
				async custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => { render(width: number): string[] }) {
					customCalled = true;
					const viewer = factory(
						{ terminal: { rows: 30 } },
						{ fg: (_color: string, text: string) => text },
						{},
						() => undefined,
					);
					expect(viewer.render(80).join("\n")).toContain("Telemetry · current session");
				},
			},
		}));
		expect(customCalled).toBe(true);
	});

	it("classifies projected tool failures and preserves projector diagnostics", async () => {
		const writer = new MemoryWriter();
		const service = new TelemetryService(fakePi().api, { runId: () => "run", writerFactory: async () => writer, revision: async () => undefined });
		service.registerTool(testTool(), defineToolTelemetry({
			input() { throw new RangeError("projection failure"); },
			result: () => ({ fields: { status: "failed", error_code: "NOT_FOUND" } }),
		}));
		await service.onSessionStart({ type: "session_start", reason: "startup" }, extensionContext());
		service.onToolExecutionStart({ type: "tool_execution_start", toolCallId: "call", toolName: "test", args: { path: "a" } });
		service.onToolExecutionEnd({ type: "tool_execution_end", toolCallId: "call", toolName: "test", result: result({ status: "failed", error_code: "NOT_FOUND" }), isError: false });
		expect(writer.records[1]).toMatchObject({ status: "error", error: { code: "NOT_FOUND" }, fields: { telemetry_input_error: "RangeError" } });
	});

	it("does not invent unfinished records at shutdown", async () => {
		const writer = new MemoryWriter();
		const service = new TelemetryService(fakePi().api, { runId: () => "run", writerFactory: async () => writer, revision: async () => undefined });
		await service.onSessionStart({ type: "session_start", reason: "startup" }, extensionContext());
		service.onToolExecutionStart({ type: "tool_execution_start", toolCallId: "pending", toolName: "host", args: {} });
		await service.onSessionShutdown({ type: "session_shutdown", reason: "quit" });
		expect(writer.records.map((record) => record.type)).toEqual(["run"]);
		expect(writer.closed).toBe(true);
	});

	it("write failure disables telemetry once without changing tool behavior", async () => {
		const notifications: string[] = [];
		const service = new TelemetryService(fakePi().api, { runId: () => "run", writerFactory: async () => new FailingWriter(), revision: async () => undefined });
		await service.onSessionStart({ type: "session_start", reason: "startup" }, extensionContext(notifications));
		expect(notifications).toEqual(["Telemetry disabled for this run after a write failure."]);
		expect(() => service.onToolExecutionStart({ type: "tool_execution_start", toolCallId: "call", toolName: "test", args: {} })).not.toThrow();
	});

	it.each(["reload", "quit"] as const)("%s releases the shared service", async (reason) => {
		const events = createEventBus();
		const firstPi = fakePi(events);
		const first = registerTelemetry(firstPi.api);
		await first.onSessionShutdown({ type: "session_shutdown", reason });
		const second = registerTelemetry(fakePi(events).api);
		expect(second).not.toBe(first);
	});
});

describe("observed tool registration", () => {
	it("keeps execution semantics and applies repair without a telemetry execute wrapper", async () => {
		let registered: TestTool | undefined;
		const pi = fakePi().api;
		pi.registerTool = (tool) => { registered = fixture<TestTool>(tool); };
		registerObservedTool(pi, { tool: testTool() });
		if (registered === undefined) throw new Error("tool not registered");
		expect(registered.prepareArguments?.({ path: "a", count: "2" })).toEqual({ path: "a", count: 2 });
		await expect(registered.execute("call", { path: "a", count: 2 }, undefined, undefined, extensionContext())).resolves.toEqual(result({ status: "ok" }));
	});

	it("rethrows the original tool exception", async () => {
		const original = new Error("business failure");
		let registered: TestTool | undefined;
		const pi = fakePi().api;
		pi.registerTool = (tool) => { registered = fixture<TestTool>(tool); };
		registerObservedTool(pi, { tool: testTool("test", async () => { throw original; }) });
		if (registered === undefined) throw new Error("tool not registered");
		await expect(registered.execute("call", { path: "a" }, undefined, undefined, extensionContext())).rejects.toBe(original);
	});
});

class MemoryWriter implements TelemetryWriter {
	readonly records: TelemetryRecord[] = [];
	closed = false;
	append(record: TelemetryRecord): boolean { this.records.push(record); return true; }
	async close(): Promise<void> { this.closed = true; }
	status(): TelemetryWriterStatus { return { enabled: !this.closed, written: this.records.length }; }
}

class FailingWriter implements TelemetryWriter {
	append(): boolean { return false; }
	async close(): Promise<void> {}
	status(): TelemetryWriterStatus { return { enabled: false, written: 0 }; }
}

function fakePi(events = createEventBus()): { api: ExtensionAPI; hooks: string[] } {
	const hooks: string[] = [];
	const api = fixture<ExtensionAPI>({
		events,
		on(event: string) { hooks.push(event); },
		getAllTools: () => [],
		getThinkingLevel: () => "high",
		registerTool() {},
	});
	return { api, hooks };
}

function testTool(name = "test", execute?: TestTool["execute"]): TestTool {
	return {
		name,
		label: name,
		description: "Test tool",
		parameters,
		execute: execute ?? (async () => result({ status: "ok" })),
	};
}

function result(details: TestDetails): AgentToolResult<TestDetails> {
	return { content: [{ type: "text", text: "ok" }], details };
}

function assistantCalls(ids: readonly string[]): unknown {
	return {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall", id, name: "test", arguments: { path: "a" } })),
		stopReason: "toolUse",
	};
}

function extensionContext(notifications: string[] = []): ExtensionContext {
	return fixture<ExtensionContext>({
		cwd: "/repo",
		mode: "interactive",
		model: { provider: "test-provider", id: "test-model" },
		ui: { notify(message: string) { notifications.push(message); } },
		sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
	});
}

function clock(): () => Date {
	let offset = 0;
	return () => new Date(Date.UTC(2026, 0, 1, 0, 0, offset++));
}

function fixture<T>(value: unknown): T {
	return value as T;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve = (_value: T): void => undefined;
	const promise = new Promise<T>((complete) => { resolve = complete; });
	return { promise, resolve };
}
