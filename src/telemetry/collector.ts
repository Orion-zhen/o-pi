import type {
	AgentStartEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

import { computeRepoMapActivation } from "../repo-map/activation.js";
import { countTextTokensSync } from "../token-counter.js";
import { decodeTelemetryRuntimeEvent, TELEMETRY_RUNTIME_CHANNEL, TELEMETRY_RUNTIME_FAILURE_CHANNEL } from "./channel.js";
import { COLLECTOR_CONTRACT_HASH, COLLECTOR_CONTRACT_MANIFEST } from "./contract.js";
import { piVersion, projectRequestedInput, resolveToolIdentity, toolDefinitionValue } from "./identity.js";
import { readTelemetrySessionDirectory, type TelemetryJsonlSnapshot } from "./jsonl-reader.js";
import { TelemetryManifestStore, type TelemetryManifestSink } from "./manifest.js";
import { stableHash } from "./projectors.js";
import { assembleToolCallEndRecord, type ActiveTurn } from "./record.js";
import { TelemetryCallStore, type ToolCallState } from "./runtime.js";
import { SessionTelemetryStore } from "./session-store.js";
import type {
	CallDimensions,
	CollectionHealthIssue,
	JsonObject,
	TelemetryBase,
	TelemetryContext,
	TelemetryRecord,
	ToolExposure,
	ToolIdentity,
	WorkloadTelemetry,
} from "./types.js";
import {
	JsonlTelemetryWriter,
	flushEmergencyHealth,
	type TelemetryWriter,
	type TelemetryWriterStatus,
	writeEmergencyHealth,
} from "./writer.js";

interface ToolExecutionStartData {
	toolCallId: string;
	toolName: string;
	args: unknown;
}

interface MessageEndData {
	message: TurnEndEvent["message"];
}

interface ToolExecutionEndData {
	toolCallId: string;
	toolName: string;
	result: { content: unknown; details: unknown };
	isError: boolean;
}

interface CallPlacement extends CallDimensions {
	toolName: string;
}

export interface TelemetryCollectorOptions {
	now?: () => Date;
	monotonicNow?: () => number;
	writerFactory?: (sessionId: string, runId: string) => TelemetryWriter;
	sessionLoader?: (sessionId: string) => Promise<TelemetryJsonlSnapshot>;
	manifestStore?: TelemetryManifestSink;
	identityTimeoutMs?: number;
	maxLiveRecords?: number;
}

export interface TelemetryCollectorSnapshot {
	sessionId?: string;
	records: readonly unknown[];
	revision: number;
	invalidLines: number;
	omittedRecords: number;
	lastCompletedTurn?: number;
	inProgressCalls: number;
	writer: TelemetryWriterStatus;
}

export class TelemetryCollector {
	readonly #now: () => Date;
	readonly #monotonicNow: () => number;
	readonly #writerFactory: (sessionId: string, runId: string) => TelemetryWriter;
	readonly #sessionLoader: (sessionId: string) => Promise<TelemetryJsonlSnapshot>;
	readonly #manifestStore: TelemetryManifestSink;
	readonly #identityTimeoutMs: number;
	readonly #maxLiveRecords: number;
	readonly #callStore = new TelemetryCallStore();
	readonly #placements = new Map<string, CallPlacement>();
	readonly #metricSchemas = new Map<string, string>();
	readonly #definitionTokens = new Map<string, ToolExposure["definition_tokens"]>();
	#runId = randomUUID();
	#sessionStore: SessionTelemetryStore | undefined;
	#writer: TelemetryWriter | undefined;
	#sessionId: string | undefined;
	#turn: ActiveTurn | undefined;
	#context: TelemetryContext = hostContext("unknown");
	#sequence = 0;
	#lastCompletedTurn: number | undefined;
	#interactionId: string | undefined;
	#workload: WorkloadTelemetry | undefined;
	#manifestFailuresReported = 0;

	constructor(options: TelemetryCollectorOptions = {}) {
		this.#now = options.now ?? (() => new Date());
		this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
		this.#writerFactory = options.writerFactory ?? ((sessionId, runId) => new JsonlTelemetryWriter(sessionId, { runId }));
		this.#manifestStore = options.manifestStore ?? new TelemetryManifestStore();
		this.#identityTimeoutMs = options.identityTimeoutMs ?? 1_000;
		this.#maxLiveRecords = options.maxLiveRecords ?? 50_000;
		this.#sessionLoader = options.sessionLoader ?? ((sessionId) => loadTelemetrySession(sessionId, this.#maxLiveRecords));
	}

	async onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
		try {
			if (this.#writer !== undefined) {
				try {
					await withTimeout(this.#writer.flush(), 1_000, "previous telemetry writer flush");
				} catch (error) {
					this.recordEmergencyHealth("writer_failure", error);
				}
			}
			const sessionId = ctx.sessionManager.getSessionId();
			this.#runId = randomUUID();
			let historical: TelemetryJsonlSnapshot = { records: [], invalidLines: 0 };
			try {
				historical = await this.#sessionLoader(sessionId);
			} catch (error) {
				this.recordEmergencyHealth("session_hydration_failure", error, sessionId);
			}
			this.#sessionId = sessionId;
			this.#writer = this.#writerFactory(sessionId, this.#runId);
			this.#manifestStore.append(COLLECTOR_CONTRACT_MANIFEST);
			await this.#manifestStore.flush();
			this.#sessionStore = new SessionTelemetryStore(sessionId, historical.records, historical.invalidLines,
				this.#maxLiveRecords, historical.omittedRecords ?? 0);
			let contextCaptureFailed = false;
			this.#context = contextFor(ctx, undefined, [], undefined, () => { contextCaptureFailed = true; });
			this.#turn = undefined;
			this.#interactionId = undefined;
			this.#workload = undefined;
			this.#placements.clear();
			this.hydrateMetricSchemas(historical.records, historical.metricSchemas);
			this.#callStore.reset();
			this.#sequence = 0;
			this.#lastCompletedTurn = latestCompletedTurn(historical.records, sessionId);
			this.append({ event: "session_start", ...this.base(this.#context), data: { reason: event.reason } });
			this.recordManifestFailures();
			if (contextCaptureFailed) this.health("context_capture_failure");
			if (this.#sessionStore.snapshot().omittedRecords > 0) this.health("live_store_truncated", { count: this.#sessionStore.snapshot().omittedRecords });
		} catch (error) {
			this.recordEmergencyHealth("collector_handler_failure", error);
		}
	}

	onAgentStart(_event: AgentStartEvent): void {
		this.guard(() => {
			this.#interactionId = randomUUID();
		});
	}

	onBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): void {
		this.guard(() => {
			const estimate = countTextTokensSync(event.prompt, modelScope(ctx));
			this.#workload = {
				prompt_hash: stableHash(event.prompt),
				shape: workloadShape(estimate.tokens, event.images?.length ?? 0),
				prompt_chars: event.prompt.length,
				prompt_tokens: { value: estimate.tokens, method: estimate.method },
				image_count: event.images?.length ?? 0,
			};
		});
	}

	async onTurnStart(
		event: TurnStartEvent,
		ctx: ExtensionContext,
		pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "getThinkingLevel">,
	): Promise<void> {
		try {
			const activeTools = [...pi.getActiveTools()].sort();
			const toolsByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
			let identityFailures = 0;
			let configCaptureFailures = 0;
			const identities = await Promise.all(activeTools.map(async (name) => {
				try {
					const resolved = await withTimeout(resolveToolIdentity(toolsByName.get(name), name, ctx), this.#identityTimeoutMs, `identity ${name}`);
					for (const manifest of resolved.manifests) this.#manifestStore.append(manifest);
					if (resolved.config_capture_failed) configCaptureFailures += 1;
					return [name, resolved.identity] as const;
				} catch {
					identityFailures += 1;
					return [name, unavailableIdentity()] as const;
				}
			}));
			const exposures = new Map(identities);
			await this.#manifestStore.flush();
			const definitions = new Map(activeTools.map((name) => [name, toolDefinitionValue(toolsByName.get(name), name)]));
			const toolsetValue = activeTools.map((name) => definitions.get(name));
			let contextCaptureFailed = false;
			const markContextFailure = () => { contextCaptureFailed = true; };
			const context = contextFor(ctx, pi.getThinkingLevel(), toolsetValue, this.#workload, markContextFailure);
			const id = `${this.#sessionId ?? "unknown"}:${event.turnIndex}:${event.timestamp}`;
			this.#context = context;
			this.#turn = {
				id,
				index: event.turnIndex,
				startedAt: this.#now().getTime(),
				startedMonotonic: this.#monotonicNow(),
				context,
				exposures,
				startedCallIds: new Set(),
				endedCallIds: new Set(),
				projectionFailureIds: new Set(),
				projectionLimitedIds: new Set(),
				...(this.#interactionId === undefined ? {} : { interactionId: this.#interactionId }),
			};
			const tools: ToolExposure[] = activeTools.map((name) => {
				const identity = exposures.get(name) ?? unavailableIdentity();
				const tokenKey = definitionTokenKey(ctx, identity.definition_hash);
				let definitionTokens = this.#definitionTokens.get(tokenKey);
				if (definitionTokens === undefined) {
					const counted = countTextTokensSync(JSON.stringify(definitions.get(name)), modelScope(ctx));
					definitionTokens = { value: counted.tokens, method: `serialized_tool_definition:${counted.method}` };
					this.#definitionTokens.set(tokenKey, definitionTokens);
				}
				return {
					name,
					...identity,
					definition_tokens: definitionTokens,
				};
			});
			const activation = computeRepoMapActivation(safeBranch(ctx, markContextFailure));
			this.append({
				event: "turn_start",
				...this.base(context),
				turn_id: id,
				...(this.#interactionId === undefined ? {} : { interaction_id: this.#interactionId }),
				data: {
					turn_index: event.turnIndex,
					tools,
					repo_map: activation === undefined
						? { enabled: false }
						: { enabled: true, freshness: activation.freshness ?? "fresh", map_id: activation.mapId },
				},
			});
			if (identityFailures > 0) this.health("identity_resolution_failure", { count: identityFailures });
			if (configCaptureFailures > 0) this.health("config_capture_failure", { count: configCaptureFailures });
			this.recordManifestFailures();
			if (contextCaptureFailed) this.health("context_capture_failure");
		} catch (error) {
			this.recordEmergencyHealth("collector_handler_failure", error);
		}
	}

	onMessageEnd(event: MessageEndData): void {
		this.guard(() => {
			if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) return;
			const calls = event.message.content.filter((part) => part.type === "toolCall");
			if (calls.length === 0) return;
			const assistantMessageId = randomUUID();
			const batchId = randomUUID();
			for (const [index, call] of calls.entries()) {
				this.#placements.set(call.id, {
					toolName: call.name,
					assistant_message_id: assistantMessageId,
					tool_batch_id: batchId,
					batch_size: calls.length,
					batch_index: index,
					...(this.#interactionId === undefined ? {} : { interaction_id: this.#interactionId }),
				});
			}
		});
	}

	onToolExecutionStart(event: ToolExecutionStartData): void {
		this.guard(() => {
			const turn = this.requireTurn();
			if (this.#callStore.get(event.toolCallId) !== undefined) {
				this.health("runtime_event_drop", { turn, toolCallId: event.toolCallId, details: { reason: "duplicate_tool_call_start" } });
				return;
			}
			const candidatePlacement = this.#placements.get(event.toolCallId);
			const placement = candidatePlacement?.toolName === event.toolName ? candidatePlacement : undefined;
			const identity = turn.exposures.get(event.toolName) ?? unavailableIdentity();
			const requested = projectRequestedInput(event.toolName, identity.telemetry_hash, event.args);
			const call = this.#callStore.start({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				turnId: turn.id,
				turnIndex: turn.index,
				identity,
				startedAt: this.#now().getTime(),
				startedMonotonic: this.#monotonicNow(),
				requested: requested.value,
				projectionFailed: requested.failed,
				projectionLimited: requested.limited,
				...(placement?.interaction_id === undefined ? {} : { interaction_id: placement.interaction_id }),
				...(placement?.assistant_message_id === undefined ? {} : { assistant_message_id: placement.assistant_message_id }),
				...(placement?.tool_batch_id === undefined ? {} : { tool_batch_id: placement.tool_batch_id }),
				...(placement?.batch_size === undefined ? {} : { batch_size: placement.batch_size }),
				...(placement?.batch_index === undefined ? {} : { batch_index: placement.batch_index }),
			});
			turn.startedCallIds.add(event.toolCallId);
			this.append({
				event: "tool_call_start",
				...this.base(turn.context),
				turn_id: turn.id,
				tool_call_id: event.toolCallId,
				...dimensions(call),
				data: { turn_index: turn.index, tool: { name: event.toolName, identity }, input: { requested: requested.value },
					...(requested.failed ? { projection_failed: true } : {}), ...(requested.limited ? { projection_limited: true } : {}) },
			});
			if (call.projectionFailed) this.recordProjectionFailure(call);
			if (call.projectionLimited) this.recordProjectionLimited(call);
		});
	}

	onRuntimeEvent(value: unknown): void {
		this.guard(() => {
			const event = decodeTelemetryRuntimeEvent(value);
			if (event === undefined) {
				this.health("runtime_event_drop");
				return;
			}
			const observedAt = this.#now().getTime();
			const observedMonotonic = this.#monotonicNow();
			const call = this.#callStore.apply(event, observedAt, observedMonotonic);
			if (call === undefined) {
				this.health("runtime_event_drop", { toolCallId: event.tool_call_id, details: { reason: "orphan_or_tool_mismatch", kind: event.kind, tool_name: event.tool_name } });
				return;
			}
			if (event.kind === "execute_start") {
				this.append({
					event: "tool_execution_start",
					...this.base(this.contextForCall(call)),
					turn_id: call.turnId,
					tool_call_id: call.toolCallId,
					...dimensions(call),
					data: {
						turn_index: call.turnIndex,
						tool: { name: call.toolName, identity: call.identity },
						input: { requested: call.requested, executed: event.executed },
						...(call.preparation === undefined ? {} : { preparation: call.preparation }),
						...(call.approval === undefined ? {} : { approval: call.approval }),
						...(call.projectionFailed ? { projection_failed: true } : {}),
						...(call.projectionLimited ? { projection_limited: true } : {}),
					},
				});
			}
			if (call.projectionFailed) this.recordProjectionFailure(call);
			if (call.projectionLimited) this.recordProjectionLimited(call);
			if (event.kind === "execute_end" && call.result !== undefined) this.finalizeCall(call, observedMonotonic);
		});
	}

	onRuntimeFailure(value: unknown): void {
		this.guard(() => {
			const details = isRecord(value) ? value : {};
			this.health("runtime_event_drop", {
				...(typeof details["tool_call_id"] === "string" ? { toolCallId: details["tool_call_id"] } : {}),
				details: {
					reason: "runtime_channel_emit_failure",
					...(typeof details["kind"] === "string" ? { kind: details["kind"] } : {}),
					...(typeof details["tool_name"] === "string" ? { tool_name: details["tool_name"] } : {}),
				},
			});
		});
	}

	onToolExecutionEnd(event: ToolExecutionEndData): void {
		this.guard(() => {
			const call = this.#callStore.finish(event.toolCallId, event.toolName, {
				content: event.result.content,
				details: event.result.details,
				isError: event.isError,
			});
			if (call === undefined) return;
			const observed = call.identity.telemetry_hash !== "unavailable";
			const terminalBeforeExecute = call.preparation?.status === "invalid" || isDenied(call);
			if (!observed || call.execute !== undefined || terminalBeforeExecute) this.finalizeCall(call, this.#monotonicNow());
		});
	}

	onTurnEnd(event: TurnEndEvent): void {
		this.guard(() => {
			const turn = this.#turn ?? this.requireTurn(event.turnIndex);
			const expectedIds = toolCalls(event).map((call) => call.id);
			for (const id of expectedIds) {
				const call = this.#callStore.get(id);
				if (call?.result === undefined) continue;
				if (call.identity.telemetry_hash !== "unavailable" && call.execute === undefined
					&& call.preparation?.status !== "invalid" && !isDenied(call)) {
					this.health("runtime_event_drop", { call, details: { reason: "missing_execute_end" } });
				}
				this.finalizeCall(call, this.#monotonicNow());
			}
			const missingStartIds = expectedIds.filter((id) => !turn.startedCallIds.has(id));
			const allCallIds = new Set([...expectedIds, ...turn.startedCallIds]);
			const missingEndIds = [...allCallIds].filter((id) => !turn.endedCallIds.has(id));
			for (const id of missingStartIds) this.health("missing_start", { turn, toolCallId: id });
			for (const id of missingEndIds) this.health("missing_end", { turn, toolCallId: id });
			this.append({
				event: "turn_end",
				...this.base(turn.context),
				turn_id: turn.id,
				...(turn.interactionId === undefined ? {} : { interaction_id: turn.interactionId }),
				data: {
					turn_index: turn.index,
					duration_ms: Math.max(0, this.#monotonicNow() - turn.startedMonotonic),
					expected_call_count: expectedIds.length,
					observed_start_count: turn.startedCallIds.size,
					observed_end_count: turn.endedCallIds.size,
					unfinished_call_count: missingEndIds.length,
					projection_failure_count: turn.projectionFailureIds.size,
					projection_limit_count: turn.projectionLimitedIds.size,
					missing_start_ids: missingStartIds,
					missing_end_ids: missingEndIds,
				},
			});
			this.#lastCompletedTurn = turn.index;
			this.#turn = undefined;
			this.#placements.clear();
			for (const call of this.#callStore.forTurn(turn.id)) this.#callStore.take(call.toolCallId);
		});
	}

	async onSessionShutdown(event: SessionShutdownEvent): Promise<void> {
		try {
			const unfinishedTurnId = this.#turn?.id;
			if (this.#turn !== undefined) this.health("unfinished_turn", { turn: this.#turn });
			this.append({
				event: "session_end",
				...this.base(this.#context),
				data: {
					reason: event.reason,
					...(unfinishedTurnId === undefined ? {} : { unfinished_turn_id: unfinishedTurnId }),
					unfinished_call_count: this.#callStore.size,
				},
			});
			await this.#manifestStore.flush();
			this.recordManifestFailures();
			await this.#writer?.flush();
			await flushEmergencyHealth();
		} catch (error) {
			this.recordEmergencyHealth("collector_handler_failure", error);
		} finally {
			this.#callStore.reset();
		}
	}

	snapshot(): TelemetryCollectorSnapshot {
		const session = this.#sessionStore?.snapshot();
		const writer = this.#writer?.status?.() ?? emptyWriterStatus();
		return {
			...(session === undefined ? {} : { sessionId: session.sessionId }),
			records: session?.records ?? [],
			revision: session?.revision ?? 0,
			invalidLines: session?.invalidLines ?? 0,
			omittedRecords: session?.omittedRecords ?? 0,
			...(this.#lastCompletedTurn === undefined ? {} : { lastCompletedTurn: this.#lastCompletedTurn }),
			inProgressCalls: this.#callStore.size,
			writer,
		};
	}

	private finalizeCall(call: ToolCallState, endedMonotonic: number): void {
		if (this.#callStore.get(call.toolCallId) === undefined) return;
		this.enforceMetricSchemas(call);
		const record = assembleToolCallEndRecord(this.base(this.contextForCall(call)), call, endedMonotonic);
		this.append(record);
		this.#turn?.endedCallIds.add(call.toolCallId);
		this.#callStore.take(call.toolCallId);
	}

	private enforceMetricSchemas(call: ToolCallState): void {
		const metrics = call.observation?.metrics;
		if (metrics === undefined) return;
		for (const [name, metric] of Object.entries(metrics)) {
			const schema = stableHash({ kind: metric.kind, aggregation: metric.aggregation, unit: "unit" in metric ? metric.unit : null });
			const key = metricSchemaKey(call.toolName, call.identity.telemetry_hash, name);
			const previous = this.#metricSchemas.get(key);
			if (previous === undefined) this.#metricSchemas.set(key, schema);
			else if (previous !== schema) {
				this.health("metric_schema_conflict", { call, details: { metric: name, observed_schema: schema, established_schema: previous } });
			}
		}
	}

	private hydrateMetricSchemas(records: readonly unknown[], schemas: readonly { key: string; schema: string }[] = []): void {
		this.#metricSchemas.clear();
		for (const schema of schemas) this.#metricSchemas.set(schema.key, schema.schema);
		for (const record of [...records].sort(compareRecordTime)) {
			for (const schema of metricSchemasFromRecord(record)) if (!this.#metricSchemas.has(schema.key)) this.#metricSchemas.set(schema.key, schema.schema);
		}
	}

	private recordProjectionFailure(call: ToolCallState): void {
		const turn = this.#turn;
		if (turn?.projectionFailureIds.has(call.toolCallId) === true) return;
		turn?.projectionFailureIds.add(call.toolCallId);
		this.health("projection_failed", { call });
	}

	private recordProjectionLimited(call: ToolCallState): void {
		const turn = this.#turn;
		if (turn?.projectionLimitedIds.has(call.toolCallId) === true) return;
		turn?.projectionLimitedIds.add(call.toolCallId);
		this.health("projection_limited", { call });
	}

	private recordManifestFailures(): void {
		const failed = this.#manifestStore.status().failed;
		const newFailures = failed - this.#manifestFailuresReported;
		if (newFailures <= 0) return;
		this.#manifestFailuresReported = failed;
		this.health("manifest_write_failure", { count: newFailures });
	}

	private health(
		issue: CollectionHealthIssue,
		options: { turn?: ActiveTurn; call?: ToolCallState; toolCallId?: string; count?: number; details?: JsonObject } = {},
	): void {
		const turn = options.turn ?? this.#turn;
		const call = options.call;
		const turnId = turn?.id ?? call?.turnId;
		const toolCallId = options.toolCallId ?? call?.toolCallId;
		this.append({
			event: "collection_health",
			...this.base(turn?.context ?? this.#context),
			...(turnId === undefined ? {} : { turn_id: turnId }),
			...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
			data: {
				issue,
				...(options.count === undefined ? {} : { count: options.count }),
				...(options.details === undefined ? {} : { details: options.details }),
			},
		});
	}

	private requireTurn(index = -1): ActiveTurn {
		if (this.#turn !== undefined) return this.#turn;
		const id = `${this.#sessionId ?? "unknown"}:${index}:unattributed`;
		this.#turn = {
			id,
			index,
			startedAt: this.#now().getTime(),
			startedMonotonic: this.#monotonicNow(),
			context: this.#context,
			exposures: new Map(),
			startedCallIds: new Set(),
			endedCallIds: new Set(),
			projectionFailureIds: new Set(),
			projectionLimitedIds: new Set(),
		};
		return this.#turn;
	}

	private contextForCall(call: ToolCallState): TelemetryContext {
		return this.#turn?.id === call.turnId ? this.#turn.context : this.#context;
	}

	private base(context: TelemetryContext): TelemetryBase {
		return {
			id: randomUUID(),
			timestamp: this.#now().toISOString(),
			session_id: this.#sessionId ?? "unknown",
			run_id: this.#runId,
			stream_id: "main",
			collector_contract_hash: COLLECTOR_CONTRACT_HASH,
			sequence: this.#sequence++,
			context,
		};
	}

	private append(record: TelemetryRecord): void {
		this.#sessionStore?.append(record);
		try {
			this.#writer?.append(record);
		} catch (error) {
			writeEmergencyHealth({ sessionId: record.session_id, runId: record.run_id,
				collectorContractHash: record.collector_contract_hash, issue: "writer_failure", error });
		}
	}

	private guard(action: () => void): void {
		try {
			action();
		} catch (error) {
			this.recordEmergencyHealth("collector_handler_failure", error);
		}
	}

	private recordEmergencyHealth(issue: CollectionHealthIssue, error: unknown, sessionId = this.#sessionId): void {
		try {
			if (sessionId === undefined) return;
			if (this.#writer === undefined) {
				writeEmergencyHealth({ sessionId, runId: this.#runId, collectorContractHash: COLLECTOR_CONTRACT_HASH, issue, error });
				return;
			}
			const details: JsonObject = { error_name: error instanceof Error ? error.name : "unknown" };
			this.health(issue, { details });
		} catch {
			// The writer itself retains a sidecar fallback for append failures.
		}
	}
}

function contextFor(
	ctx: ExtensionContext,
	thinkingLevel: string | undefined,
	toolset: unknown[],
	workload: WorkloadTelemetry | undefined,
	onFailure?: () => void,
): TelemetryContext {
	const active = toolset.map((item) => isRecord(item) && typeof item["name"] === "string" ? item["name"] : "unknown");
	const branch = safeBranch(ctx, onFailure);
	const leafId = safeLeafId(ctx, onFailure);
	return {
		cwd: ctx.cwd,
		...(ctx.model === undefined ? {} : { model: { provider: ctx.model.provider, id: ctx.model.id } }),
		...(thinkingLevel === undefined ? {} : { thinking_level: thinkingLevel }),
		toolset: { active, hash: stableHash(toolset) },
		...(workload === undefined ? {} : { workload }),
		host: {
			pi_version: piVersion(),
			...(ctx.mode === undefined ? {} : { mode: ctx.mode }),
			platform: process.platform,
			arch: process.arch,
			node_version: process.version,
		},
		branch: {
			...(leafId === null ? {} : { leaf_id: leafId }),
			lineage_hash: stableHash(branch.map((entry) => entry.id)),
			depth: branch.length,
		},
	};
}

function hostContext(cwd: string): TelemetryContext {
	return {
		cwd,
		host: {
			pi_version: piVersion(),
			platform: process.platform,
			arch: process.arch,
			node_version: process.version,
		},
	};
}

function modelScope(ctx: ExtensionContext): { provider?: string; modelId?: string } {
	return ctx.model === undefined ? {} : { provider: ctx.model.provider, modelId: ctx.model.id };
}

function definitionTokenKey(ctx: ExtensionContext, definitionHash: string): string {
	return `${ctx.model?.provider ?? "unknown"}\0${ctx.model?.id ?? "unknown"}\0${definitionHash}`;
}

function dimensions(call: ToolCallState): CallDimensions {
	return {
		...(call.interaction_id === undefined ? {} : { interaction_id: call.interaction_id }),
		...(call.assistant_message_id === undefined ? {} : { assistant_message_id: call.assistant_message_id }),
		...(call.tool_batch_id === undefined ? {} : { tool_batch_id: call.tool_batch_id }),
		...(call.batch_size === undefined ? {} : { batch_size: call.batch_size }),
		...(call.batch_index === undefined ? {} : { batch_index: call.batch_index }),
	};
}

function unavailableIdentity(): ToolIdentity {
	return {
		behavior_hash: "unavailable",
		definition_hash: "unavailable",
		telemetry_hash: "unavailable",
		config_hash: "unavailable",
	};
}

function emptyWriterStatus(): TelemetryWriterStatus {
	return { pending: 0, persisted: 0, failed: 0, health_persisted: 0, health_failed: 0, dropped: 0 };
}

function latestCompletedTurn(records: readonly unknown[], sessionId: string): number | undefined {
	let latest: { index: number; timestamp: string } | undefined;
	for (const record of records) {
		if (!isRecord(record) || record["session_id"] !== sessionId || record["event"] !== "turn_end") continue;
		const data = record["data"];
		if (!isRecord(data) || typeof data["turn_index"] !== "number") continue;
		const timestamp = typeof record["timestamp"] === "string" ? record["timestamp"] : "";
		if (latest === undefined || timestamp > latest.timestamp) latest = { index: data["turn_index"], timestamp };
	}
	return latest?.index;
}

function toolCalls(event: TurnEndEvent): Array<{ id: string; name: string }> {
	if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) return [];
	return event.message.content.flatMap((part) => part.type === "toolCall" ? [{ id: part.id, name: part.name }] : []);
}

function isDenied(call: ToolCallState): boolean {
	return call.approval?.decision === "deny"
		|| call.approval?.outcome === "deny"
		|| call.approval?.outcome === "deny_with_instruction"
		|| call.approval?.outcome === "dismissed";
}

function safeBranch(ctx: ExtensionContext, onFailure?: () => void): ReturnType<ExtensionContext["sessionManager"]["getBranch"]> {
	try {
		return typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
	} catch {
		onFailure?.();
		return [];
	}
}

function safeLeafId(ctx: ExtensionContext, onFailure?: () => void): string | null {
	try {
		return typeof ctx.sessionManager.getLeafId === "function" ? ctx.sessionManager.getLeafId() : null;
	} catch {
		onFailure?.();
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadTelemetrySession(sessionId: string, maxRecords: number): Promise<TelemetryJsonlSnapshot> {
	const schemas = new Map<string, { key: string; schema: string; timestamp: string }>();
	const snapshot = await readTelemetrySessionDirectory(sessionId, { maxRecords, onRecord(record) {
		if (!isRecord(record) || record["session_id"] !== sessionId) return;
		for (const schema of metricSchemasFromRecord(record)) {
			const existing = schemas.get(schema.key);
			if (existing === undefined || schema.timestamp < existing.timestamp) schemas.set(schema.key, schema);
		}
	} });
	return {
		records: snapshot.records.filter((record) => isRecord(record) && record["session_id"] === sessionId),
		invalidLines: snapshot.invalidLines,
		...(snapshot.omittedRecords === undefined ? {} : { omittedRecords: snapshot.omittedRecords }),
		metricSchemas: [...schemas.values()],
	};
}

function compareRecordTime(left: unknown, right: unknown): number {
	const leftTime = isRecord(left) && typeof left["timestamp"] === "string" ? left["timestamp"] : "";
	const rightTime = isRecord(right) && typeof right["timestamp"] === "string" ? right["timestamp"] : "";
	return leftTime < rightTime ? -1 : leftTime > rightTime ? 1 : 0;
}

function metricSchemaKey(toolName: string, instrumentationHash: string, metricName: string): string {
	return `${toolName}\0${instrumentationHash}\0${metricName}`;
}

function metricSchemasFromRecord(record: unknown): Array<{ key: string; schema: string; timestamp: string }> {
	if (!isRecord(record) || record["event"] !== "tool_call_end") return [];
	const data = record["data"];
	if (!isRecord(data)) return [];
	const tool = data["tool"];
	const result = data["result"];
	if (!isRecord(tool) || !isRecord(result) || typeof tool["name"] !== "string") return [];
	const identity = tool["identity"];
	const metrics = result["metrics"];
	if (!isRecord(identity) || !isRecord(metrics) || typeof identity["telemetry_hash"] !== "string") return [];
	const toolName = tool["name"];
	const instrumentationHash = identity["telemetry_hash"];
	const timestamp = typeof record["timestamp"] === "string" ? record["timestamp"] : "";
	return Object.entries(metrics).flatMap(([name, metric]) => !isRecord(metric) ? [] : [{
		key: metricSchemaKey(toolName, instrumentationHash, name),
		schema: stableHash({ kind: metric["kind"], aggregation: metric["aggregation"], unit: metric["unit"] ?? null }),
		timestamp,
	}]);
}

export function registerTelemetry(
	pi: Pick<ExtensionAPI, "events" | "getActiveTools" | "getAllTools" | "getThinkingLevel" | "on">,
	options: TelemetryCollectorOptions = {},
): TelemetryCollector {
	const collector = new TelemetryCollector(options);
	const disposeRuntime = pi.events.on(TELEMETRY_RUNTIME_CHANNEL, (value) => collector.onRuntimeEvent(value));
	const disposeRuntimeFailure = pi.events.on(TELEMETRY_RUNTIME_FAILURE_CHANNEL, (value) => collector.onRuntimeFailure(value));
	pi.on("session_start", (event, ctx) => collector.onSessionStart(event, ctx));
	pi.on("before_agent_start", (event, ctx) => collector.onBeforeAgentStart(event, ctx));
	pi.on("agent_start", (event) => collector.onAgentStart(event));
	pi.on("turn_start", (event, ctx) => collector.onTurnStart(event, ctx, pi));
	pi.on("message_end", (event) => collector.onMessageEnd(event));
	pi.on("tool_execution_start", (event) => collector.onToolExecutionStart(event));
	pi.on("tool_execution_end", (event) => collector.onToolExecutionEnd(event));
	pi.on("turn_end", (event) => collector.onTurnEnd(event));
	pi.on("session_shutdown", async (event) => {
		await collector.onSessionShutdown(event);
		if (event.reason === "reload" || event.reason === "quit") {
			disposeRuntime();
			disposeRuntimeFailure();
		}
	});
	return collector;
}

function workloadShape(tokens: number, images: number): string {
	const tokenBucket = tokens <= 64 ? "xs" : tokens <= 256 ? "s" : tokens <= 1024 ? "m" : tokens <= 4096 ? "l" : "xl";
	const imageBucket = images === 0 ? "no_image" : images === 1 ? "one_image" : "multi_image";
	return `${tokenBucket}:${imageBucket}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
