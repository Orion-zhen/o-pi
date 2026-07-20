import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
	createEventBus,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type RegisteredCommand,
	type ToolDefinition,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import telemetryExtension from "../../agent/extensions/telemetry.js";
import { bashTelemetry } from "../../src/bash-tool/telemetry.js";
import { findTelemetry } from "../../src/file-tools/telemetry/find.js";
import { readTelemetry } from "../../src/file-tools/telemetry/read.js";
import { boundedTelemetryPayload, decodeToolObservation, defineToolTelemetry, safeObserve, type DefinedToolTelemetry } from "../../src/telemetry/adapter.js";
import { decodeTelemetryRuntimeEvent, emitTelemetryRuntime, TELEMETRY_RUNTIME_CHANNEL } from "../../src/telemetry/channel.js";
import { registerTelemetry } from "../../src/telemetry/collector.js";
import { COLLECTOR_CONTRACT_HASH } from "../../src/telemetry/contract.js";
import { computeTelemetryHash, computeToolBehaviorHash } from "../../src/telemetry/identity.js";
import { categoricalMetric, compactJson, countMetric, scalar } from "../../src/telemetry/projectors.js";
import { manifestValueFingerprint } from "../../src/telemetry/manifest.js";
import { registerObservedTool } from "../../src/telemetry/tool.js";
import { readTelemetrySessionDirectory } from "../../src/telemetry/jsonl-reader.js";
import type {
	CollectionHealthRecord,
	TelemetryRecord,
	TurnStartRecord,
} from "../../src/telemetry/types.js";
import { JsonlTelemetryWriter, telemetrySessionFile, type TelemetryWriter } from "../../src/telemetry/writer.js";
import { webSearchTelemetry } from "../../src/web-tools/telemetry/websearch.js";
import { calculateLiveReport } from "../../src/telemetry-report/live.js";
import { useTempDir } from "../helpers/lifecycle.js";

const paramsSchema = Type.Object(
	{ path: Type.String(), count: Type.Optional(Type.Integer()) },
	{ additionalProperties: false },
);
type TestParams = Parameters<ToolDefinition<typeof paramsSchema>["execute"]>[1];

interface TestDetails {
	status?: "failed" | "timed_out" | "aborted";
	error?: { code: string };
	truncated?: boolean;
}

const temp = useTempDir("o-pi-telemetry-");

describe("telemetry raw collection", () => {
	it("registers every raw lifecycle boundary", () => {
		const lifecycleEvents: string[] = [];
		telemetryExtension({
			events: createEventBus(),
			on(event: string) {
				lifecycleEvents.push(event);
			},
			getActiveTools: () => [],
			getAllTools: () => [],
			getThinkingLevel: () => "off",
			registerCommand() {},
		} as unknown as ExtensionAPI);

		expect(lifecycleEvents).toEqual([
			"session_start",
			"before_agent_start",
			"agent_start",
			"turn_start",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
			"turn_end",
			"session_shutdown",
		]);
	});

	it("loads telemetry analysis only when its command is invoked", async () => {
		let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		telemetryExtension({
			events: createEventBus(),
			on() {},
			getActiveTools: () => [],
			getAllTools: () => [],
			getThinkingLevel: () => "off",
			registerCommand(_name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
				handler = command.handler;
			},
		} as unknown as ExtensionAPI);
		if (handler === undefined) throw new Error("telemetry command was not registered");
		const notifications: string[] = [];
		await handler("unexpected", {
			...context(),
			ui: { notify(message: string) { notifications.push(message); } },
		} as ExtensionCommandContext);
		expect(notifications).toEqual(["usage: /telemetry"]);
	});

	it("reuses one coordinator and allows tools to omit specialized telemetry", () => {
		const lifecycle = new Map<string, number>();
		const tools: string[] = [];
		const pi = {
			events: createEventBus(),
			on(event: string) {
				lifecycle.set(event, (lifecycle.get(event) ?? 0) + 1);
			},
			registerTool(tool: { name: string }) {
				tools.push(tool.name);
			},
			getActiveTools: () => tools,
			getAllTools: () => [],
			getThinkingLevel: () => "off",
		} as unknown as ExtensionAPI;
		for (const name of ["first", "second"]) {
			registerObservedTool(pi, {
				tool: { ...testTool(async () => successResult()), name, label: name },
				source: new URL("../../src/bash-tool/index.ts", import.meta.url),
			});
		}

		expect(tools).toEqual(["first", "second"]);
		expect(Object.fromEntries(lifecycle)).toEqual({
			tool_execution_start: 1,
			tool_execution_end: 1,
			session_start: 1,
		});
	});

	it("keeps behavior, telemetry, config, and runtime context identities separate", async () => {
		const tool = testTool(async () => successResult());
		const behaviorBefore = computeToolBehaviorHash(tool, ["src/bash-tool/index.ts"], { pathFields: ["path"] });
		const behaviorAfter = computeToolBehaviorHash(tool, ["src/bash-tool/index.ts"], { pathFields: ["path"] });
		const firstTelemetry = computeTelemetryHash(testTelemetry);
		const secondTelemetry = computeTelemetryHash(defineToolTelemetry<TestParams, TestDetails>(import.meta.url, {}));

		expect(behaviorAfter).toBe(behaviorBefore);
		expect(secondTelemetry).not.toBe(firstTelemetry);

		const harness = await createHarness();
		const start = harness.records.find((record): record is TurnStartRecord => record.event === "turn_start");
		const exposure = start?.data.tools[0];
		expect(exposure).toMatchObject({
			name: "test",
			behavior_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
			definition_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
			telemetry_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
			config_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
			definition_tokens: { value: expect.any(Number), method: expect.any(String) },
		});
		expect(start?.context).toMatchObject({
			model: { provider: "openai", id: "gpt-5.4" },
			thinking_level: "high",
			toolset: { active: ["test"], hash: expect.any(String) },
			host: { pi_version: expect.any(String), platform: process.platform },
			branch: { lineage_hash: expect.any(String), depth: 1, leaf_id: "entry-1" },
			workload: { prompt_hash: expect.stringMatching(/^[a-f0-9]{64}$/u), shape: "xs:one_image", prompt_chars: 12, image_count: 1 },
		});
		expect(harness.records.every((record) => /^[a-f0-9]{64}$/u.test(record.collector_contract_hash))).toBe(true);
		expect(new Set(harness.records.map((record) => record.run_id)).size).toBe(1);
	});

	it("sanitizes structured observations without retaining result bodies", () => {
		expect(decodeToolObservation({
			attributes: { cache: { layer: "memory", hit: true }, ignored: Number.NaN },
			measurements: [{ name: "matches", value: 3, unit: "item" }, { name: "bad", value: Number.NaN }],
			stages: [{ name: "primary", status: "failed", duration_ms: 5, attributes: { backend: "local" } }, { body: "discard" }],
		})).toEqual({
			attributes: { cache: { layer: "memory", hit: true } },
			measurements: [{ name: "matches", value: 3, unit: "item" }],
			stages: [{ name: "primary", status: "failed", duration_ms: 5, attributes: { backend: "local" } }],
		});
	});

	it("bounds projection depth, width, and string payloads before they enter the runtime channel", () => {
		const payload = { text: "x".repeat(10_000), values: Array.from({ length: 400 }, (_value, index) => index) };
		const bounded = boundedTelemetryPayload(payload);
		expect(bounded.limited).toBe(true);
		expect(JSON.stringify(bounded.value).length).toBeLessThan(8_000);
		expect((bounded.value as { values: unknown[] }).values).toHaveLength(256);
	});

	it("reuses already-sanitized in-process runtime events without cloning their payload", () => {
		const events = createEventBus();
		let received: unknown;
		events.on(TELEMETRY_RUNTIME_CHANNEL, (value) => { received = value; });
		const event = {
			kind: "execute_start" as const,
			tool_call_id: "call-1",
			tool_name: "test",
			executed: { value: { path: "src/a.ts" } },
		};
		expect(emitTelemetryRuntime(events, event)).toBe(true);
		expect(decodeTelemetryRuntimeEvent(received)).toBe(event);
	});

	it("fingerprints complete manifest values even when their inspectable projection is bounded", () => {
		const left = Array.from({ length: 300 }, (_value, index) => index);
		const right = [...left];
		right[299] = 999;
		expect(manifestValueFingerprint(left)).not.toBe(manifestValueFingerprint(right));
	});

	it("persists a minimal call start before preparation so a crash remains unfinished", async () => {
		const harness = await createHarness();
		await harness.announceBatch([{ id: "crash", arguments: { path: "src/a.ts" } }]);
		await harness.start("crash", { path: "src/a.ts" });

		const starts = harness.ofType("tool_call_start");
		expect(starts).toHaveLength(1);
		expect(starts[0]).toMatchObject({
			tool_call_id: "crash",
			assistant_message_id: expect.any(String),
			tool_batch_id: expect.any(String),
			batch_size: 1,
			batch_index: 0,
			data: { input: { requested: { value: { path: "src/a.ts" } } } },
		});
		expect(harness.ofType("tool_call_end")).toHaveLength(0);
		expect(harness.collector.snapshot().inProgressCalls).toBe(1);
	});

	it("keeps parallel calls in one batch, preserves source order, and records actual completion order", async () => {
		const pending = new Map<string, ReturnType<typeof deferred<AgentToolResult<TestDetails>>>>();
		const harness = await createHarness((_params, id) => {
			const wait = deferred<AgentToolResult<TestDetails>>();
			pending.set(id, wait);
			return wait.promise;
		});
		const calls = [
			{ id: "first", arguments: { path: "same.ts" } },
			{ id: "second", arguments: { path: "same.ts" } },
		];
		await harness.announceBatch(calls);
		for (const call of calls) {
			await harness.start(call.id, call.arguments);
			harness.prepare(call.arguments);
		}
		const firstExecution = harness.execute("first", { path: "same.ts" });
		const secondExecution = harness.execute("second", { path: "same.ts" });
		pending.get("second")?.resolve(successResult("second"));
		await secondExecution;
		await harness.endExecution("second", successResult("second"), false);
		pending.get("first")?.resolve(successResult("first"));
		await firstExecution;
		await harness.endExecution("first", successResult("first"), false);
		await harness.endTurn(calls);

		const starts = harness.ofType("tool_call_start");
		const executionStarts = harness.ofType("tool_execution_start");
		const ends = harness.ofType("tool_call_end");
		expect(starts.map((record) => [record.tool_call_id, record.batch_index])).toEqual([["first", 0], ["second", 1]]);
		expect(new Set(starts.map((record) => record.tool_batch_id)).size).toBe(1);
		expect(executionStarts.map((record) => record.tool_call_id)).toEqual(["first", "second"]);
		expect(ends.map((record) => record.tool_call_id)).toEqual(["second", "first"]);
		expect(ends.every((record) => record.data.timing.execution_started_at !== undefined)).toBe(true);
	});

	it("records stable metric semantics and reports schema conflicts without dropping observations", async () => {
		expect(decodeToolObservation({ metrics: { exit_code: { value: 2 } } }).metrics).toEqual({});
		expect(decodeToolObservation({
			metrics: { exit_code: { kind: "categorical", aggregation: "count_by_value", value: 2 } },
		}).metrics?.["exit_code"]).toMatchObject({ kind: "categorical", aggregation: "count_by_value", value: 2 });
		expect(decodeToolObservation({
			metrics: {
				negative_count: { kind: "count", aggregation: "sum", value: -1, unit: "item" },
				invalid_ratio: { kind: "ratio", aggregation: "mean", value: 2, unit: "ratio" },
			},
		}).metrics).toEqual({});

		const dynamic = defineToolTelemetry<TestParams, TestDetails>(import.meta.url, {
			executed: (params) => ({ value: { path: params.path } }),
			result(params) {
				return { metrics: { unstable: params.path === "category" ? categoricalMetric(1) : countMetric(1, "item") } };
			},
		});
		const harness = await createHarness(undefined, dynamic);
		for (const pathValue of ["category", "count"] as const) {
			const id = pathValue;
			await harness.announceBatch([{ id, arguments: { path: pathValue } }]);
			await harness.start(id, { path: pathValue });
			harness.prepare({ path: pathValue });
			await harness.execute(id, { path: pathValue });
			await harness.endExecution(id, successResult(), false);
		}
		const ends = harness.ofType("tool_call_end");
		expect(ends[0]?.data.result.metrics["unstable"]).toMatchObject({ kind: "categorical" });
		expect(ends[1]?.data.result.metrics["unstable"]).toMatchObject({ kind: "count", value: 1, unit: "item" });
		expect(harness.ofType("collection_health").some((record) => record.data.issue === "metric_schema_conflict")).toBe(true);
	});

	it("records complete turn exposure and explicit missing start/end integrity", async () => {
		const harness = await createHarness();
		const calls = [
			{ id: "unfinished", arguments: { path: "a.ts" } },
			{ id: "never-started", arguments: { path: "b.ts" } },
		];
		await harness.announceBatch(calls);
		await harness.start("unfinished", { path: "a.ts" });
		await harness.endTurn(calls);

		const end = harness.ofType("turn_end")[0];
		expect(end?.data).toMatchObject({
			expected_call_count: 2,
			observed_start_count: 1,
			observed_end_count: 0,
			unfinished_call_count: 2,
			missing_start_ids: ["never-started"],
			missing_end_ids: ["unfinished", "never-started"],
		});
		expect(harness.ofType("collection_health").map((record) => [record.data.issue, record.tool_call_id])).toEqual([
			["missing_start", "never-started"],
			["missing_end", "unfinished"],
			["missing_end", "never-started"],
		]);
		expect(harness.records.map((record) => record.sequence)).toEqual(harness.records.map((_record, index) => index));
	});

	it("persists projection failures as collection-health facts", async () => {
		const adapter = defineToolTelemetry<TestParams, TestDetails>(import.meta.url, {
			requested() {
				throw new Error("projection failed");
			},
		});
		const harness = await createHarness(undefined, adapter);
		const call = { id: "projection", arguments: { path: "secret.ts" } };
		await harness.announceBatch([call]);
		await harness.start(call.id, call.arguments);
		harness.prepare(call.arguments);
		await harness.execute(call.id, { path: "secret.ts" });
		await harness.endExecution(call.id, successResult(), false);

		expect(harness.ofType("collection_health")).toEqual([
			expect.objectContaining({ tool_call_id: "projection", data: { issue: "projection_failed" } }),
		]);
		expect(JSON.stringify(harness.records)).not.toContain("secret.ts");
	});

	it("preserves independent reference ranks, raw sources, families, and resource state", () => {
		const find = observe(findTelemetry,
			{ query: "service", path: "src" },
			{
				content: [],
				details: {
					query: "service",
					path: "src",
					strategy: "fuzzy",
					totalMatches: 1,
					returnedMatches: 1,
					scannedEntries: 2,
					matches: [{ path: "src/a.ts", kind: "file" }],
					collapsedGroups: [],
					displayedMatches: [{ path: "src/a.ts", kind: "file" }],
					candidateSources: { "src/a.ts": ["lsp-typescript", "bm25"] },
					ignoredCount: 0,
					skippedCount: 0,
					scanTruncated: false,
					resultLimited: false,
					outputTruncated: false,
				},
			},
		);
		expect(find.references?.[0]).toMatchObject({
			global_rank: 1,
			group_rank: 1,
			sources: expect.arrayContaining([
				{ id: "lsp-typescript", family: "lsp" },
				{ id: "bm25", family: "lexical" },
			]),
		});

		const web = observe(webSearchTelemetry, { query: "docs", limit: 1 }, {
			content: [],
			details: {
				status: "success",
				query: "docs",
				provider: "exa_mcp",
				results: [{ rank: 7, title: "A", url: "https://example.com" }],
				cached: false,
				downloaded_bytes: 10,
				duration_ms: 1,
				attempts: [],
			},
		});
		expect(web.references?.[0]).toMatchObject({ sources: [{ id: "exa_mcp", family: "websearch", source_rank: 7 }] });

		const read = observe(readTelemetry, { path: "src/a.ts" }, {
			content: [],
			details: {
				path: "src/a.ts",
				content: "hello",
				start_line: 2,
				end_line: 3,
				total_lines: 3,
				size_bytes: 5,
				version: "revision-1",
				encoding: "utf-8",
				newline: "lf",
				truncated: false,
				bom: false,
			},
		});
		expect(read.references?.[0]?.resource).toMatchObject({
			revision: "revision-1",
			start_line: 2,
			end_line: 3,
			content_hash: { algorithm: "sha256", value: expect.stringMatching(/^[a-f0-9]{64}$/u) },
		});
	});

	it("classifies categorical numeric metrics instead of treating them as continuous", () => {
		const observation = observe(bashTelemetry, { command: "false" }, {
			content: [],
			details: {
				status: "exited",
				exit_code: 2,
				duration_ms: 10,
				output_state: "complete",
				output_format: "text",
				total_lines: 1,
				returned_lines: 1,
				total_bytes: 4,
				returned_bytes: 4,
				capture_complete: true,
			},
		});
		expect(observation.metrics?.["exit_code"]).toEqual({
			kind: "categorical",
			aggregation: "count_by_value",
			value: 2,
		});
		expect(observation.metrics?.["duration"]).toMatchObject({ kind: "duration", unit: "ms" });
		expect(observation.metrics?.["total_bytes"]).toMatchObject({ kind: "bytes", unit: "byte" });
	});

	it("writes an offline collection-health sidecar when the primary writer fails", async () => {
		const writer = new JsonlTelemetryWriter("failed/session", {
			directory: temp.path,
			append: async () => Promise.reject(Object.assign(new Error("disk full"), { code: "ENOSPC" })),
			acquireLock: async () => async () => undefined,
		});
		writer.append(baseRecord());
		await writer.flush();

		expect(writer.status()).toMatchObject({ failed: 1, health_persisted: 1, health_failed: 0 });
		const files = await readdir(temp.path);
		const healthFile = files.find((file) => file.endsWith(".health.jsonl"));
		if (healthFile === undefined) throw new Error("health sidecar was not written");
		const health = JSON.parse((await readFile(path.join(temp.path, healthFile), "utf8")).trim()) as CollectionHealthRecord;
		expect(health).toMatchObject({
			event: "collection_health",
			sequence: 0,
			data: {
				issue: "writer_failure",
				details: { failed_event: "session_start", failed_sequence: 0, error_code: "ENOSPC" },
			},
		});
	});

	it("drops beyond the bounded writer queue and persists one backpressure health fact", async () => {
		const blocked = deferred<void>();
		const health: string[] = [];
		const writer = new JsonlTelemetryWriter("bounded", {
			directory: temp.path,
			maxPending: 1,
			append: async () => blocked.promise,
			appendHealth: async (_file, content) => { health.push(content); },
			acquireLock: async () => async () => undefined,
		});
		writer.append(baseRecord());
		writer.append({ ...baseRecord(), id: "overflow", sequence: 1 });
		expect(writer.status()).toMatchObject({ dropped: 1, failed: 1 });
		blocked.resolve();
		await writer.flush();
		expect(health).toHaveLength(1);
		expect(health[0]).toContain("TELEMETRY_BACKPRESSURE");
	});

	it("persists a synchronous event burst with one lock and durable append", async () => {
		const writes: string[] = [];
		let locks = 0;
		const writer = new JsonlTelemetryWriter("batch", {
			directory: temp.path,
			append: async (_file, content) => { writes.push(content); },
			acquireLock: async () => {
				locks += 1;
				return async () => undefined;
			},
		});
		writer.append(baseRecord());
		writer.append({ ...baseRecord(), id: "record-1", sequence: 1 });
		await writer.flush();

		expect(locks).toBe(1);
		expect(writes).toHaveLength(1);
		expect(writes[0]?.trim().split("\n")).toHaveLength(2);
		expect(writer.status()).toMatchObject({ pending: 0, persisted: 2, failed: 0 });
	});

	it("streams only the newest requested session records while observing the full history", async () => {
		const directory = path.join(temp.path, "bounded-reader");
		await mkdir(directory, { recursive: true });
		const sessionId = "bounded-session";
		const rows = [0, 1, 2].map((index) => ({ ...baseRecord(), id: `row-${index}`, session_id: sessionId,
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), sequence: index }));
		await writeFile(telemetrySessionFile(sessionId, "run-1", directory), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
		let observed = 0;
		const snapshot = await readTelemetrySessionDirectory(sessionId, { directory, maxRecords: 2, onRecord: () => { observed += 1; } });
		expect(snapshot.records.map((record) => isRecord(record) ? record["id"] : undefined)).toEqual(["row-1", "row-2"]);
		expect(snapshot).toMatchObject({ omittedRecords: 1 });
		expect(observed).toBe(3);
	});

	it("analyzes historical integrity without replaying duplicate health events on resume", async () => {
		const records: TelemetryRecord[] = [];
		const collector = registerTelemetry(minimalPi(), {
			writerFactory: () => memoryWriter(records),
			manifestStore: memoryManifestStore(),
			sessionLoader: async () => ({
				records: [
					{ ...baseRecord(), session_id: "session-1", sequence: 0 },
					{ ...baseRecord(), id: "later", session_id: "session-1", sequence: 2 },
				],
				invalidLines: 1,
			}),
		});
		await collector.onSessionStart({ type: "session_start", reason: "resume" }, context());
		const health = records.filter((record): record is CollectionHealthRecord => record.event === "collection_health");
		expect(health).toEqual([]);
		expect(records.map((record) => record.sequence)).toEqual([0]);
		const report = calculateLiveReport(collector.snapshot());
		expect(report.collection_health.counts).toMatchObject({ invalid_lines: 1, sequence_gaps: 1 });
	});
});

const testTelemetry = defineToolTelemetry<TestParams, TestDetails>(import.meta.url, {
	input(value) {
		if (!isRecord(value)) return { value: {} };
		return { value: compactJson({ path: scalar(value["path"]), count: scalar(value["count"]) }) };
	},
	result(_params, result) {
		return {
			metrics: { observed: categoricalMetric(true) },
			...(result.details.status === undefined ? {} : { status: result.details.status }),
			...(result.details.error?.code === undefined ? {} : { error_code: result.details.error.code }),
			truncated: result.details.truncated === true,
		};
	},
});

type ExecuteTestTool = (params: TestParams, toolCallId: string) => Promise<AgentToolResult<TestDetails>>;
type LifecycleHandler = (event: unknown, context: ExtensionContext) => unknown;

async function createHarness(
	execute: ExecuteTestTool = async () => successResult(),
	telemetry: DefinedToolTelemetry<TestParams, TestDetails> = testTelemetry,
) {
	const records: TelemetryRecord[] = [];
	const events = createEventBus();
	const lifecycle = new Map<string, LifecycleHandler[]>();
	let registered: ToolDefinition<typeof paramsSchema, TestDetails> | undefined;
	const contextValue = context();
	const pi = {
		events,
		on(event: string, handler: LifecycleHandler) {
			const handlers = lifecycle.get(event);
			if (handlers === undefined) lifecycle.set(event, [handler]);
			else handlers.push(handler);
		},
		registerTool(tool: ToolDefinition<typeof paramsSchema, TestDetails>) {
			registered = tool;
		},
		getActiveTools: () => ["test"],
		getAllTools: () => registered === undefined ? [] : [{
			name: registered.name,
			description: registered.description,
			parameters: registered.parameters,
			promptGuidelines: registered.promptGuidelines,
			sourceInfo: { path: "/test", source: "test", scope: "temporary", origin: "top-level" },
		}],
		getThinkingLevel: () => "high",
	} as unknown as ExtensionAPI;
	let tick = 0;
	const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++));
	const collector = registerTelemetry(pi, { writerFactory: () => memoryWriter(records), now, manifestStore: memoryManifestStore() });
	registerObservedTool(pi, {
		tool: testTool(execute),
		repair: { pathFields: ["path"] },
		telemetry,
		source: new URL("../../src/bash-tool/index.ts", import.meta.url),
		config: () => ({ mode: "test" }),
	});
	await invoke(lifecycle, "session_start", { type: "session_start", reason: "startup" }, contextValue);
	await invoke(lifecycle, "before_agent_start", { type: "before_agent_start", prompt: "inspect repo", images: [{}] }, contextValue);
	await invoke(lifecycle, "agent_start", { type: "agent_start" }, contextValue);
	await invoke(lifecycle, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 }, contextValue);
	const tool = registered;
	if (tool === undefined) throw new Error("observed tool was not registered");

	return {
		collector,
		records,
		ofType<T extends TelemetryRecord["event"]>(event: T): Array<Extract<TelemetryRecord, { event: T }>> {
			return records.filter((record): record is Extract<TelemetryRecord, { event: T }> => record.event === event);
		},
		async announceBatch(calls: readonly CallSpec[]) {
			await invoke(lifecycle, "message_end", { type: "message_end", message: assistantMessage(calls) }, contextValue);
		},
		async start(id: string, args: unknown) {
			await invoke(lifecycle, "tool_execution_start", { type: "tool_execution_start", toolCallId: id, toolName: "test", args }, contextValue);
		},
		prepare(args: unknown): TestParams {
			return tool.prepareArguments?.(args) ?? decodeParams(args);
		},
		execute(id: string, params: TestParams) {
			return tool.execute(id, params, undefined, undefined, contextValue);
		},
		async endExecution(id: string, result: AgentToolResult<TestDetails>, isError: boolean) {
			await invoke(lifecycle, "tool_execution_end", {
				type: "tool_execution_end",
				toolCallId: id,
				toolName: "test",
				result,
				isError,
			}, contextValue);
		},
		async endTurn(calls: readonly CallSpec[]) {
			await invoke(lifecycle, "turn_end", turnEnd(calls), contextValue);
		},
	};
}

function testTool(execute: ExecuteTestTool): ToolDefinition<typeof paramsSchema, TestDetails> {
	return {
		name: "test",
		label: "test",
		description: "test",
		parameters: paramsSchema,
		execute: (toolCallId, params) => execute(params, toolCallId),
	};
}

async function invoke(
	lifecycle: ReadonlyMap<string, readonly LifecycleHandler[]>,
	event: string,
	payload: unknown,
	contextValue: ExtensionContext,
): Promise<void> {
	for (const handler of lifecycle.get(event) ?? []) await handler(payload, contextValue);
}

interface CallSpec {
	id: string;
	arguments: Record<string, unknown>;
}

function assistantMessage(calls: readonly CallSpec[]) {
	return {
		role: "assistant" as const,
		content: calls.map((call) => ({ type: "toolCall" as const, id: call.id, name: "test", arguments: call.arguments })),
		api: "openai-responses" as const,
		provider: "openai",
		model: "gpt-5.4",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse" as const,
		timestamp: 1,
	};
}

function turnEnd(calls: readonly CallSpec[]): TurnEndEvent {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: assistantMessage(calls),
		toolResults: [],
	};
}

function successResult(text = "ok", details: TestDetails = {}): AgentToolResult<TestDetails> {
	return { content: [{ type: "text", text }], details };
}

function observe<TParams, TDetails>(
	telemetry: DefinedToolTelemetry<TParams, TDetails>,
	params: TParams,
	result: AgentToolResult<TDetails>,
) {
	return safeObserve(telemetry, params, result).value;
}

function context(): ExtensionContext {
	return {
		cwd: "/workspace",
		mode: "tui",
		model: { provider: "openai", id: "gpt-5.4" },
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [{ id: "entry-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", type: "custom", customType: "test" }],
			getLeafId: () => "entry-1",
		},
	} as unknown as ExtensionContext;
}

function memoryWriter(records: TelemetryRecord[]): TelemetryWriter {
	return {
		append(record) {
			records.push(record);
		},
		async flush() {},
		status: () => ({ pending: 0, persisted: records.length, failed: 0, health_persisted: 0, health_failed: 0, dropped: 0 }),
	};
}

function memoryManifestStore() {
	return { append() {}, async flush() {}, status: () => ({ failed: 0 }) };
}

function minimalPi(): ExtensionAPI {
	return {
		events: createEventBus(),
		on() {},
		getActiveTools: () => [],
		getAllTools: () => [],
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;
}

function baseRecord(): TelemetryRecord {
	return {
		event: "session_start",
		id: "record-0",
		timestamp: "2026-01-01T00:00:00.000Z",
		session_id: "failed/session",
		run_id: "run-1",
		stream_id: "main",
		collector_contract_hash: COLLECTOR_CONTRACT_HASH,
		sequence: 0,
		context: {
			cwd: "/workspace",
			host: { pi_version: "test", platform: process.platform, arch: process.arch, node_version: process.version },
		},
		data: { reason: "startup" },
	};
}

function decodeParams(value: unknown): TestParams {
	if (!isRecord(value) || typeof value["path"] !== "string") throw new Error("invalid params");
	return { path: value["path"], ...(typeof value["count"] === "number" ? { count: value["count"] } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}
