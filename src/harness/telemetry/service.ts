import type {
	AgentToolResult,
	ExtensionAPI,
	MessageEndEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolResultEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

import type { RepairObservation } from "../tool-repair/types.js";
import {
	repairObservation,
	TELEMETRY_READY_CHANNEL,
	TELEMETRY_REPAIR_CHANNEL,
	TELEMETRY_TOOL_CHANNEL,
	telemetryToolRegistration,
	type TelemetryToolDefinition,
	type TelemetryToolRegistration,
} from "./events.js";
import { mergeFacts, safeProject, stableHash } from "./projection.js";
import type {
	CallBatch,
	CallRecord,
	Fields,
	GitRevision,
	RunRecord,
	TelemetryFacts,
	TelemetryRecord,
} from "./types.js";
import type { TelemetryWriter } from "./writer.js";
import { attachTelemetryService } from "./pi-adapter.js";

export type TelemetryPi = Pick<ExtensionAPI, "events" | "getAllTools" | "getThinkingLevel" | "on">;

export interface TelemetrySessionContext {
	cwd: string;
	sessionId: string;
	notify: (message: string) => void;
}

export interface TelemetryTurnContext {
	model?: { provider: string; id: string };
}

type TelemetryExecutionEndEvent = Omit<ToolExecutionEndEvent, "result"> & { result: AgentToolResult<unknown> };

interface ToolState extends TelemetryToolRegistration {
	definitionHash?: string;
}

interface TurnContext {
	index: number;
	model?: { provider: string; id: string };
	thinking: string;
}

interface PendingCall {
	id: string;
	index: number;
	tool: string;
	definitionHash?: string;
	turn?: TurnContext;
	startedAt: number;
	startedMonotonic: number;
	rawParams: unknown;
	params: unknown;
	inputFacts: TelemetryFacts;
	inputProjected: boolean;
	resultFacts: TelemetryFacts;
	resultProjected: boolean;
	inputProjector?: TelemetryToolRegistration["input"];
	resultProjector?: TelemetryToolRegistration["result"];
	repair?: CallRecord["repair"];
	batch?: CallBatch;
}

interface RunState {
	id: string;
	sessionId: string;
	header: RunRecord;
	enabled: boolean;
	writer?: TelemetryWriter;
	initializing?: Promise<void>;
	queued: CallRecord[];
	notify: (message: string) => void;
}

export interface TelemetryServiceSnapshot {
	run_id?: string;
	session_id?: string;
	enabled: boolean;
	pending_calls: number;
	records: TelemetryRecord[];
}

export interface TelemetryServiceOptions {
	now?: () => Date;
	monotonicNow?: () => number;
	runId?: () => string;
	revision?: (cwd: string) => Promise<GitRevision | undefined>;
	writerFactory?: (runId: string, onError: (error: unknown) => void) => Promise<TelemetryWriter>;
}

export function registerTelemetry(pi: TelemetryPi, options: TelemetryServiceOptions = {}): TelemetryService {
	const service = new TelemetryService(pi, options);
	pi.events.on(TELEMETRY_TOOL_CHANNEL, (value) => service.registerTool(telemetryToolRegistration(value)));
	pi.events.on(TELEMETRY_REPAIR_CHANNEL, (value) => service.prepared(repairObservation(value)));
	attachTelemetryService(pi, service);
	pi.events.emit(TELEMETRY_READY_CHANNEL, undefined);
	return service;
}

export class TelemetryService {
	readonly #now: () => Date;
	readonly #monotonicNow: () => number;
	readonly #runId: () => string;
	readonly #captureRevision: (cwd: string) => Promise<GitRevision | undefined>;
	readonly #writerFactory: NonNullable<TelemetryServiceOptions["writerFactory"]>;
	readonly #tools = new Map<string, ToolState>();
	readonly #pending = new Map<string, PendingCall>();
	readonly #declaredBatches = new Map<string, CallBatch>();
	readonly #records: TelemetryRecord[] = [];
	readonly #pendingByParams = new Map<unknown, PendingCall>();
	#run: RunState | undefined;
	#turn: TurnContext | undefined;
	#nextCallIndex = 0;

	constructor(private readonly pi: Pick<TelemetryPi, "getAllTools" | "getThinkingLevel">, options: TelemetryServiceOptions = {}) {
		this.#now = options.now ?? (() => new Date());
		this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
		this.#runId = options.runId ?? randomUUID;
		this.#captureRevision = options.revision ?? (async (cwd) => (await import("./revision.js")).captureGitRevision(cwd));
		this.#writerFactory = options.writerFactory ?? (async (runId, onError) => (await import("./writer.js")).JsonlTelemetryWriter.open(runId, { onError }));
	}

	registerTool(registration: TelemetryToolRegistration): void {
		this.#tools.set(registration.definition.name, registration);
	}

	/** Return an isolated snapshot for the current session's live report. */
	snapshot(): TelemetryServiceSnapshot {
		const run = this.#run;
		return {
			...(run === undefined ? {} : { run_id: run.id, session_id: run.sessionId }),
			enabled: run?.enabled === true,
			pending_calls: this.#pending.size,
			records: structuredClone(this.#records),
		};
	}

	onSessionStart(event: SessionStartEvent, context: TelemetrySessionContext): void {
		const previous = this.#run;
		this.resetRunState();
		const runId = this.#runId();
		const sessionId = context.sessionId;
		const header = {
			type: "run",
			run_id: runId,
			at: this.#now().toISOString(),
			session_id: sessionId,
			reason: event.reason,
			cwd: context.cwd,
		} satisfies RunRecord;
		this.#run = {
			id: runId,
			sessionId,
			header,
			enabled: true,
			queued: [],
			notify: context.notify,
		};
		this.#records.push(header);
		if (previous !== undefined) void this.closeRun(previous);
	}

	onTurnStart(event: TurnStartEvent, context: TelemetryTurnContext): void {
		this.#turn = {
			index: event.turnIndex,
			...(context.model === undefined
				? {}
				: { model: { provider: context.model.provider, id: context.model.id } }),
			thinking: this.pi.getThinkingLevel(),
		};
	}

	onMessageEnd(event: MessageEndEvent): void {
		const message = event.message;
		if (message.role !== "assistant") return;
		const size = message.content.filter((part) => part.type === "toolCall").length;
		if (size === 0) return;
		const id = randomUUID();
		let index = 0;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			this.#declaredBatches.set(part.id, { id, size, index });
			index += 1;
		}
	}

	onToolExecutionStart(event: ToolExecutionStartEvent): void {
		if (this.enabledRun() === undefined) return;
		const tool = this.toolState(event.toolName);
		const batch = this.#declaredBatches.get(event.toolCallId);
		const pending: PendingCall = {
			id: event.toolCallId,
			index: this.#nextCallIndex++,
			tool: event.toolName,
			...(tool?.definitionHash === undefined ? {} : { definitionHash: tool.definitionHash }),
			...(this.#turn === undefined ? {} : { turn: this.#turn }),
			startedAt: this.#now().getTime(),
			startedMonotonic: this.#monotonicNow(),
			rawParams: event.args,
			params: event.args,
			inputFacts: {},
			inputProjected: false,
			resultFacts: {},
			resultProjected: false,
			...(tool?.input === undefined ? {} : { inputProjector: tool.input }),
			...(tool?.result === undefined ? {} : { resultProjector: tool.result }),
			...(batch === undefined ? {} : { batch }),
		};
		this.#declaredBatches.delete(event.toolCallId);
		this.#pending.set(event.toolCallId, pending);
		this.#pendingByParams.set(event.args, pending);
	}

	prepared(observation: RepairObservation): void {
		if (this.enabledRun() === undefined) return;
		const call = this.#pendingByParams.get(observation.rawArgs);
		if (call === undefined || call.tool !== observation.toolName || call.repair !== undefined) {
			throw new Error(`Telemetry repair observation does not match pending call: ${observation.toolName}`);
		}
		this.#pendingByParams.delete(observation.rawArgs);
		call.repair = {
			status: observation.status,
			operations: [...new Set(observation.operations)],
			...(observation.fanout === undefined ? {} : { fanout: { ...observation.fanout } }),
		};
		call.params = observation.preparedArgs;
		call.inputProjected = false;
	}

	onToolResult(event: ToolResultEvent): void {
		if (this.enabledRun() === undefined) return;
		const call = this.pendingCall(event.toolCallId, event.toolName);
		this.projectPreparedInput(call, event.input);
		const resultProjector = call.resultProjector;
		if (resultProjector === undefined || !hasProjectableDetails(event)) return;
		const projected = safeProject(() => resultProjector(readonlyView(call.params), readonlyView(event.details)));
		call.resultFacts = mergeFacts(projected.facts, projectionAnnotations("result", projected));
		call.resultProjected = true;
	}

	onToolExecutionEnd(event: TelemetryExecutionEndEvent): void {
		const run = this.enabledRun();
		if (run === undefined) return;
		const call = this.pendingCall(event.toolCallId, event.toolName);
		this.#pending.delete(event.toolCallId);
		this.#pendingByParams.delete(call.rawParams);
		if (call.inputProjector !== undefined && !call.inputProjected && !event.isError) {
			throw new Error(`Telemetry input was not prepared before completion: ${call.tool}`);
		}
		if (call.resultProjector !== undefined && !call.resultProjected && !event.isError) {
			throw new Error(`Telemetry result was not observed before completion: ${call.tool}`);
		}
		const facts = mergeFacts(call.inputFacts, call.resultFacts);
		const ended = this.#now();
		const status = classify(event.isError, facts.fields);
		const output = outputFacts(event.result);
		const errorCode = typeof facts.fields?.["error_code"] === "string" ? facts.fields["error_code"] : undefined;
		this.append(run, {
			type: "call",
			run_id: run.id,
			at: ended.toISOString(),
			call_id: call.id,
			call_index: call.index,
			...(call.turn === undefined ? {} : {
				turn_index: call.turn.index,
				...(call.turn.model === undefined ? {} : { model: call.turn.model }),
				thinking: call.turn.thinking,
			}),
			tool: call.tool,
			...(call.definitionHash === undefined ? {} : { definition_hash: call.definitionHash }),
			started_at: new Date(call.startedAt).toISOString(),
			ended_at: ended.toISOString(),
			duration_ms: this.#monotonicNow() - call.startedMonotonic,
			status,
			...(status === "success" ? {} : { error: { ...(errorCode === undefined ? {} : { code: errorCode }) } }),
			output_chars: output.chars,
			output_lines: output.lines,
			...(output.truncated || facts.fields?.["truncated"] === true ? { truncated: true } : {}),
			...(call.repair === undefined ? {} : { repair: call.repair }),
			...(call.batch === undefined ? {} : { batch: call.batch }),
			...facts,
		} satisfies CallRecord);
	}

	async onSessionShutdown(_event: SessionShutdownEvent): Promise<void> {
		await this.closeCurrentRun();
	}

	private projectPreparedInput(call: PendingCall, params: unknown): void {
		call.params = params;
		call.inputProjected = true;
		const inputProjector = call.inputProjector;
		if (inputProjector === undefined) return;
		const projected = safeProject(() => inputProjector(readonlyView(params)));
		call.inputFacts = mergeFacts(projected.facts, projectionAnnotations("input", projected));
	}

	private toolState(name: string): ToolState | undefined {
		const registered = this.#tools.get(name);
		if (registered !== undefined) {
			registered.definitionHash ??= definitionHash(registered.definition);
			return registered;
		}
		const current = this.pi.getAllTools().find((tool) => tool.name === name);
		if (current === undefined) return undefined;
		const definition: TelemetryToolDefinition = {
			name: current.name,
			description: current.description,
			parameters: current.parameters,
			...(current.promptGuidelines === undefined ? {} : { promptGuidelines: current.promptGuidelines }),
		};
		const discovered: ToolState = { definition, definitionHash: definitionHash(definition) };
		this.#tools.set(name, discovered);
		return discovered;
	}

	private ensureRunInitialized(run: RunState): void {
		if (run.initializing !== undefined || !run.enabled || run.queued.length === 0) return;
		const initialization = this.initializeRun(run);
		run.initializing = initialization;
	}

	private async initializeRun(run: RunState): Promise<void> {
		const resources = Promise.all([
			this.#writerFactory(run.id, () => this.disableRun(run)),
			this.#captureRevision(run.header.cwd),
		] as const);
		try {
			const [writer, git] = await resources;
			if (!run.enabled) {
				await writer.close().catch(() => undefined);
				return;
			}
			run.writer = writer;
			const originalHeader = run.header;
			const header = git === undefined ? originalHeader : { ...originalHeader, git };
			run.header = header;
			if (this.#run === run && this.#records[0] === originalHeader) this.#records[0] = header;
			if (!this.writeToRun(run, header)) return;
			for (const record of run.queued) {
				if (!this.writeToRun(run, record)) return;
			}
			run.queued.length = 0;
		} catch {
			this.disableRun(run);
		}
	}

	private append(run: RunState, record: CallRecord): void {
		if (run.writer === undefined) {
			run.queued.push(record);
			this.#records.push(record);
			this.ensureRunInitialized(run);
			return;
		}
		if (this.writeToRun(run, record)) this.#records.push(record);
	}

	private writeToRun(run: RunState, record: TelemetryRecord): boolean {
		if (!run.enabled || run.writer === undefined) return false;
		if (run.writer.append(record)) return true;
		this.disableRun(run);
		return false;
	}

	private disableRun(run: RunState): void {
		if (!run.enabled) return;
		run.enabled = false;
		run.queued.length = 0;
		if (this.#run !== run) return;
		this.#pending.clear();
		this.#pendingByParams.clear();
		this.#records.length = 0;
		run.notify("Telemetry disabled for this run after a write failure.");
	}

	private enabledRun(): RunState | undefined {
		const run = this.#run;
		return run?.enabled === true ? run : undefined;
	}

	private pendingCall(id: string, tool: string): PendingCall {
		const call = this.#pending.get(id);
		if (call === undefined || call.tool !== tool) {
			throw new Error(`Telemetry completion does not match pending call: ${tool}`);
		}
		return call;
	}

	private async closeCurrentRun(): Promise<void> {
		const run = this.#run;
		this.#pending.clear();
		this.#pendingByParams.clear();
		this.#declaredBatches.clear();
		if (run === undefined) return;
		await this.closeRun(run);
	}

	private async closeRun(run: RunState): Promise<void> {
		await run.initializing;
		await run.writer?.close().catch(() => this.disableRun(run));
	}

	private resetRunState(): void {
		this.#pending.clear();
		this.#pendingByParams.clear();
		this.#declaredBatches.clear();
		this.#records.length = 0;
		this.#turn = undefined;
		this.#nextCallIndex = 0;
	}
}

function projectionAnnotations(scope: "input" | "result", projected: { error?: string; limited: boolean }): TelemetryFacts {
	return {
		fields: {
			...(projected.error === undefined ? {} : { [`telemetry_${scope}_error`]: projected.error }),
			...(projected.limited ? { [`telemetry_${scope}_limited`]: true } : {}),
		},
	};
}

function hasProjectableDetails(event: ToolResultEvent): boolean {
	if (event.details === undefined) return false;
	return !(event.isError && isRecord(event.details) && Object.keys(event.details).length === 0);
}

function classify(isError: boolean, fields: Fields | undefined): CallRecord["status"] {
	if (isError) return "error";
	const status = fields?.["status"];
	return status === "error" || status === "failed" || status === "timed_out" || typeof fields?.["error_code"] === "string"
		? "error"
		: "success";
}

function outputFacts(result: AgentToolResult<unknown>): { chars: number; lines: number; truncated: boolean } {
	let chars = 0;
	let lines = 0;
	for (const part of result.content) {
		if (part.type !== "text") continue;
		chars += part.text.length;
		if (part.text.length === 0) continue;
		lines += 1;
		for (let index = 0; index < part.text.length; index += 1) {
			if (part.text.charCodeAt(index) === 10) lines += 1;
		}
	}
	return { chars, lines, truncated: detectsTruncation(result.details) };
}

function detectsTruncation(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value["truncated"] === true) return true;
	if (value["output_state"] === "truncated" || value["output_state"] === "capture_truncated") return true;
	const truncation = value["truncation"];
	return isRecord(truncation) && truncation["truncated"] === true;
}

function definitionHash(tool: TelemetryToolDefinition): string {
	return stableHash({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.promptSnippet === undefined ? {} : { prompt_snippet: tool.promptSnippet }),
		...(tool.promptGuidelines === undefined ? {} : { prompt_guidelines: tool.promptGuidelines }),
	});
}

/** 惰性隔离 projector 输入，不复制未访问的 JSON-like payload 分支。 */
function readonlyView<T>(value: T): T {
	if (!isObject(value)) return value;
	const proxies = new WeakMap<object, object>();
	const wrap = (current: unknown): unknown => {
		if (!isObject(current)) return current;
		const existing = proxies.get(current);
		if (existing !== undefined) return existing;
		const proxy = new Proxy(current, {
			get(target, property, receiver) {
				return wrap(Reflect.get(target, property, receiver));
			},
			set: () => false,
			deleteProperty: () => false,
			defineProperty: () => false,
			setPrototypeOf: () => false,
		});
		proxies.set(current, proxy);
		return proxy;
	};
	return wrap(value) as T;
}

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return isObject(value) && !Array.isArray(value);
}
