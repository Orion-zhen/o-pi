import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolDefinition,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { TSchema } from "typebox";

import { advanceRepoMapActivation, computeRepoMapActivation, type RepoMapActivation } from "../repo-map/activation.js";
import type { RepairObservation, ToolArgumentStatus } from "../tool-repair/types.js";
import { mergeFacts, safeProject, stableHash } from "./projection.js";
import type {
	CallBatch,
	CallRecord,
	Fields,
	GitRevision,
	RunRecord,
	TelemetryFacts,
	TelemetryRecord,
	TelemetryResult,
	ToolTelemetry,
} from "./types.js";
import type { TelemetryWriter } from "./writer.js";

type TelemetryPi = Pick<ExtensionAPI, "events" | "getAllTools" | "getThinkingLevel" | "on">;

interface ErasedTelemetry {
	input?: (params: unknown) => TelemetryFacts;
	result?: (params: unknown, result: TelemetryResult<unknown>) => TelemetryFacts;
}

interface ToolExecutionStartData {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: unknown;
}

interface ToolExecutionEndData {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: AgentToolResult<unknown>;
	isError: boolean;
}

interface MessageEndData {
	message: TurnEndEvent["message"];
}

interface ToolState {
	definition: ToolDefinitionShape;
	definitionHash?: string;
	telemetry?: ErasedTelemetry;
}

interface ToolDefinitionShape {
	name: string;
	description?: unknown;
	parameters?: unknown;
	promptSnippet?: unknown;
	promptGuidelines?: unknown;
}

interface TurnContext {
	index: number;
	model?: { provider: string; id: string };
	thinking?: string;
	repoMap: { enabled: boolean; freshness?: string; map_id?: string };
}

interface PendingCall {
	id: string;
	index: number;
	tool: string;
	definitionHash?: string;
	turn?: TurnContext;
	startedAt: number;
	startedMonotonic: number;
	params: unknown;
	inputFacts: TelemetryFacts;
	inputProjected: boolean;
	telemetry?: ErasedTelemetry;
	repair?: CallRecord["repair"];
	batch?: CallBatch;
}

interface RunState {
	id: string;
	sessionId: string;
	enabled: boolean;
	warned: boolean;
	closing: boolean;
	writer?: TelemetryWriter;
	initializing?: Promise<void>;
	queued: TelemetryRecord[];
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

const SERVICE_SLOT = Symbol.for("o-pi.telemetry.service");
const fallbackServices = new WeakMap<object, TelemetryService>();
const runtimeByService = new WeakMap<TelemetryService, object>();

/** Return the telemetry collector shared by all extensions in one Pi runtime. */
export function telemetryServiceFor(pi: TelemetryPi): TelemetryService {
	const runtime = runtimeKey(pi);
	const existing = sharedService(runtime) ?? fallbackServices.get(runtime);
	if (existing !== undefined) return existing;
	const service = new TelemetryService(pi);
	runtimeByService.set(service, runtime);
	if (installSharedService(runtime, service)) return sharedService(runtime) ?? service;
	fallbackServices.set(runtime, service);
	return service;
}

export function registerTelemetry(pi: TelemetryPi): TelemetryService {
	const service = telemetryServiceFor(pi);
	service.attach(pi);
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
	#pendingByParams = new WeakMap<object, PendingCall>();
	#run: RunState | undefined;
	#turn: TurnContext | undefined;
	#repoMapCursor: { leafId: string | null; activation?: RepoMapActivation } | undefined;
	#nextCallIndex = 0;
	#attached = false;

	constructor(private readonly pi: Pick<TelemetryPi, "getAllTools" | "getThinkingLevel">, options: TelemetryServiceOptions = {}) {
		this.#now = options.now ?? (() => new Date());
		this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
		this.#runId = options.runId ?? randomUUID;
		this.#captureRevision = options.revision ?? (async (cwd) => (await import("./revision.js")).captureGitRevision(cwd));
		this.#writerFactory = options.writerFactory ?? (async (runId, onError) => (await import("./writer.js")).JsonlTelemetryWriter.open(runId, { onError }));
	}

	attach(pi: Pick<TelemetryPi, "on">): void {
		if (this.#attached) return;
		this.#attached = true;
		try { pi.on("session_start", (event, ctx) => { void this.onSessionStart(event, ctx); }); } catch {}
		try { pi.on("turn_start", (event, ctx) => this.onTurnStart(event, ctx)); } catch {}
		try { pi.on("message_end", (event) => this.onMessageEnd(event)); } catch {}
		try { pi.on("tool_execution_start", (event) => this.onToolExecutionStart(event)); } catch {}
		try { pi.on("tool_result", (event) => this.onToolResult(event)); } catch {}
		try { pi.on("tool_execution_end", (event) => this.onToolExecutionEnd(event)); } catch {}
		try { pi.on("session_shutdown", (event) => this.onSessionShutdown(event)); } catch {}
	}

	registerTool<TParams extends TSchema, TDetails, TState>(
		tool: ToolDefinition<TParams, TDetails, TState>,
		telemetry?: ToolTelemetry<Parameters<ToolDefinition<TParams, TDetails, TState>["execute"]>[1], TDetails>,
	): void {
		this.guard(() => {
			this.#tools.set(tool.name, {
				definition: tool,
				...(telemetry === undefined ? {} : { telemetry: eraseTelemetry(telemetry) }),
			});
		});
	}

	/** Return an isolated snapshot for the current session's live report. */
	snapshot(): TelemetryServiceSnapshot {
		const run = this.#run;
		return {
			...(run === undefined ? {} : { run_id: run.id, session_id: run.sessionId }),
			enabled: run?.enabled === true,
			pending_calls: this.#pending.size,
			records: clone(this.#records),
		};
	}

	onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
		try {
			const previous = this.#run;
			this.resetRunState();
			const runId = this.#runId();
			const sessionId = safeSessionId(ctx);
			const run: RunState = {
				id: runId,
				sessionId,
				enabled: true,
				warned: false,
				closing: false,
				queued: [],
				notify: (message) => {
					try { ctx.ui.notify(message, "warning"); } catch {}
				},
			};
			this.#run = run;
			const startedAt = this.#now().toISOString();
			const initialization = this.initializeRun(run, previous, event, ctx.cwd, startedAt);
			run.initializing = initialization;
			return initialization;
		} catch {
			// Telemetry cannot affect session startup.
			return Promise.resolve();
		}
	}

	onTurnStart(event: TurnStartEvent, ctx: ExtensionContext): void {
		this.guard(() => {
			const activation = this.repoMapActivation(ctx);
			this.#turn = {
				index: event.turnIndex,
				...(ctx.model === undefined ? {} : { model: { provider: ctx.model.provider, id: ctx.model.id } }),
				...optionalThinking(this.pi),
				repoMap: activation === undefined
					? { enabled: false }
					: {
						enabled: true,
						...(activation.freshness === undefined ? {} : { freshness: activation.freshness }),
						map_id: activation.mapId,
					},
			};
		});
	}

	onMessageEnd(event: MessageEndData): void {
		this.guard(() => {
			const message = event.message;
			if (message.role !== "assistant" || !Array.isArray(message.content)) return;
			let size = 0;
			for (const part of message.content) {
				if (part.type === "toolCall") size += 1;
			}
			if (size === 0) return;
			const id = randomUUID();
			let index = 0;
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				this.#declaredBatches.set(part.id, { id, size, index });
				index += 1;
			}
		});
	}

	onToolExecutionStart(event: ToolExecutionStartData): void {
		this.guard(() => {
			if (!this.enabled()) return;
			const tool = this.toolState(event.toolName);
			const batch = this.#declaredBatches.get(event.toolCallId);
			const pending: PendingCall = {
				id: event.toolCallId,
				index: this.#nextCallIndex++,
				tool: event.toolName,
				...(tool.definitionHash === undefined ? {} : { definitionHash: tool.definitionHash }),
				...(this.#turn === undefined ? {} : { turn: this.#turn }),
				startedAt: this.#now().getTime(),
				startedMonotonic: this.#monotonicNow(),
				params: event.args,
				inputFacts: {},
				inputProjected: false,
				...(tool.telemetry === undefined ? {} : { telemetry: tool.telemetry }),
				...(batch === undefined ? {} : { batch }),
			};
			this.#declaredBatches.delete(event.toolCallId);
			this.#pending.set(event.toolCallId, pending);
			if (isObject(event.args)) this.#pendingByParams.set(event.args, pending);
		});
	}

	prepared(observation: RepairObservation): void {
		this.guard(() => {
			if (!this.enabled()) return;
			let call = isObject(observation.rawArgs) ? this.#pendingByParams.get(observation.rawArgs) : undefined;
			if (call?.tool !== observation.toolName || call.repair !== undefined) call = undefined;
			if (call === undefined) {
				for (const candidate of this.#pending.values()) {
					if (candidate.tool !== observation.toolName || candidate.repair !== undefined) continue;
					if (candidate.params === observation.rawArgs) {
						call = candidate;
						break;
					}
					call ??= candidate;
				}
			}
			if (call === undefined) return;
			call.repair = { status: observation.status, operations: [...new Set(observation.operations)] };
			call.params = observation.preparedArgs;
			call.inputProjected = false;
		});
	}

	onToolResult(event: ToolResultEvent): void {
		this.guard(() => {
			const call = this.#pending.get(event.toolCallId);
			if (call === undefined || call.tool !== event.toolName) return;
			this.projectPreparedInput(call, event.input);
		});
	}

	onToolExecutionEnd(event: ToolExecutionEndData): void {
		this.guard(() => {
			if (!this.enabled()) return;
			const call = this.#pending.get(event.toolCallId);
			if (call === undefined || call.tool !== event.toolName) return;
			this.#pending.delete(event.toolCallId);
			if (!call.inputProjected) this.projectPreparedInput(call, call.params);
			const projected = safeProject(call.telemetry?.result === undefined
				? undefined
				: () => call.telemetry?.result?.(readonlyView(call.params), { details: readonlyView(event.result.details) }) ?? {});
			const facts = mergeFacts(call.inputFacts, projected.facts, projectionAnnotations("result", projected));
			const ended = this.#now();
			const status = classify(event.isError, call.repair?.status, facts.fields);
			const output = outputFacts(event.result);
			const errorCode = typeof facts.fields?.["error_code"] === "string" ? facts.fields["error_code"] : undefined;
			this.append({
				type: "call",
				run_id: this.#run?.id ?? "unknown",
				at: ended.toISOString(),
				call_id: call.id,
				call_index: call.index,
				...(call.turn === undefined ? {} : {
					turn_index: call.turn.index,
					...(call.turn.model === undefined ? {} : { model: call.turn.model }),
					...(call.turn.thinking === undefined ? {} : { thinking: call.turn.thinking }),
					repo_map: call.turn.repoMap,
				}),
				tool: call.tool,
				...(call.definitionHash === undefined ? {} : { definition_hash: call.definitionHash }),
				started_at: new Date(call.startedAt).toISOString(),
				ended_at: ended.toISOString(),
				duration_ms: Math.max(0, this.#monotonicNow() - call.startedMonotonic),
				status,
				...(status === "success" ? {} : { error: { ...(errorCode === undefined ? {} : { code: errorCode }) } }),
				output_chars: output.chars,
				output_lines: output.lines,
				...(output.truncated || facts.fields?.["truncated"] === true ? { truncated: true } : {}),
				...(call.repair === undefined ? {} : { repair: call.repair }),
				...(call.batch === undefined ? {} : { batch: call.batch }),
				...facts,
			} satisfies CallRecord);
		});
	}

	async onSessionShutdown(event: SessionShutdownEvent): Promise<void> {
		try { await this.closeCurrentRun(); } catch {}
		finally {
			if (event.reason === "reload" || event.reason === "quit") releaseSharedService(this);
		}
	}

	private projectPreparedInput(call: PendingCall, params: unknown): void {
		call.params = params;
		call.inputProjected = true;
		if (call.telemetry?.input === undefined) return;
		const projected = safeProject(() => call.telemetry?.input?.(readonlyView(params)) ?? {});
		call.inputFacts = mergeFacts(projected.facts, projectionAnnotations("input", projected));
	}

	private repoMapActivation(ctx: ExtensionContext): RepoMapActivation | undefined {
		const manager = ctx.sessionManager;
		try {
			const leafId = manager.getLeafId();
			const cursor = this.#repoMapCursor;
			if (cursor?.leafId === leafId) return cursor.activation;
			const entries: SessionEntry[] = [];
			let entryId = leafId;
			let extendsCursor = cursor?.leafId === null;
			while (entryId !== null) {
				if (cursor !== undefined && entryId === cursor.leafId) {
					extendsCursor = true;
					break;
				}
				const entry = manager.getEntry(entryId);
				if (entry === undefined || entry.parentId === entry.id) throw new Error("Invalid session branch");
				entries.push(entry);
				entryId = entry.parentId;
			}
			entries.reverse();
			const activation = advanceRepoMapActivation(extendsCursor ? cursor?.activation : undefined, entries);
			this.#repoMapCursor = { leafId, ...(activation === undefined ? {} : { activation }) };
			return activation;
		} catch {
			const activation = computeRepoMapActivation(safeBranch(ctx));
			this.#repoMapCursor = undefined;
			return activation;
		}
	}

	private toolState(name: string): Partial<ToolState> {
		const registered = this.#tools.get(name);
		if (registered !== undefined) {
			registered.definitionHash ??= definitionHash(registered.definition);
			return registered;
		}
		const current = safeAllTools(this.pi).find((tool) => tool.name === name);
		if (current === undefined) return {};
		const discovered: ToolState = { definition: current, definitionHash: definitionHash(current) };
		this.#tools.set(name, discovered);
		return discovered;
	}

	private async initializeRun(
		run: RunState,
		previous: RunState | undefined,
		event: SessionStartEvent,
		cwd: string,
		startedAt: string,
	): Promise<void> {
		const resources = Promise.all([
			this.#writerFactory(run.id, (error) => this.disableRun(run.id, error)),
			this.#captureRevision(cwd).catch(() => undefined),
		] as const);
		try {
			if (previous !== undefined) await this.closeRun(previous);
			const [writer, git] = await resources;
			if (run.closing || this.#run !== run) {
				await writer.close().catch(() => undefined);
				return;
			}
			run.writer = writer;
			this.appendToRun(run, {
				type: "run",
				run_id: run.id,
				at: startedAt,
				session_id: run.sessionId,
				reason: event.reason,
				cwd,
				...(git === undefined ? {} : { git }),
			} satisfies RunRecord);
			for (const record of run.queued) this.appendToRun(run, record);
			run.queued.length = 0;
		} catch (error) {
			this.disableRun(run.id, error);
		}
	}

	private append(record: TelemetryRecord): void {
		const run = this.#run;
		if (run === undefined || !run.enabled) return;
		if (run.writer === undefined) {
			if (!run.closing) run.queued.push(record);
			return;
		}
		this.appendToRun(run, record);
	}

	private appendToRun(run: RunState, record: TelemetryRecord): void {
		if (!run.enabled || run.writer === undefined) return;
		try {
			if (run.writer.append(record) !== true) {
				this.disableRun(run.id, new Error("Telemetry write failed"));
				return;
			}
			if (this.#run === run) this.#records.push(record);
		} catch (error) {
			this.disableRun(run.id, error);
		}
	}

	private disableRun(runId: string, _error: unknown): void {
		const run = this.#run;
		if (run === undefined || run.id !== runId || !run.enabled) return;
		run.enabled = false;
		this.#pending.clear();
		run.queued.length = 0;
		if (!run.warned) {
			run.warned = true;
			run.notify("Telemetry disabled for this run after a write failure.");
		}
	}

	private enabled(): boolean {
		return this.#run?.enabled === true;
	}

	private async closeCurrentRun(): Promise<void> {
		const run = this.#run;
		this.#pending.clear();
		this.#declaredBatches.clear();
		if (run === undefined) return;
		await this.closeRun(run);
	}

	private async closeRun(run: RunState): Promise<void> {
		run.closing = true;
		await run.initializing?.catch(() => undefined);
		await run.writer?.close().catch((error: unknown) => this.disableRun(run.id, error));
	}

	private resetRunState(): void {
		this.#pending.clear();
		this.#pendingByParams = new WeakMap<object, PendingCall>();
		this.#declaredBatches.clear();
		this.#records.length = 0;
		this.#turn = undefined;
		this.#repoMapCursor = undefined;
		this.#nextCallIndex = 0;
	}

	private guard(action: () => void): void {
		try { action(); } catch {}
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

function classify(isError: boolean, repair: ToolArgumentStatus | undefined, fields: Fields | undefined): CallRecord["status"] {
	if (isError || repair === "invalid") return "error";
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
	if (["truncated", "outputTruncated", "resultLimited", "scanTruncated"].some((key) => value[key] === true)) return true;
	if (value["output_state"] === "truncated" || value["output_state"] === "capture_truncated") return true;
	const truncation = value["truncation"];
	return isRecord(truncation) && truncation["truncated"] === true;
}

function definitionHash(tool: { name: string; description?: unknown; parameters?: unknown; promptSnippet?: unknown; promptGuidelines?: unknown }): string {
	try {
		return stableHash({
			name: tool.name,
			...(tool.description === undefined ? {} : { description: tool.description }),
			...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
			...(tool.promptSnippet === undefined ? {} : { prompt_snippet: tool.promptSnippet }),
			...(tool.promptGuidelines === undefined ? {} : { prompt_guidelines: tool.promptGuidelines }),
		});
	} catch {
		return stableHash({ name: tool.name });
	}
}

function eraseTelemetry<TParams, TDetails>(telemetry: ToolTelemetry<TParams, TDetails>): ErasedTelemetry {
	return {
		...(telemetry.input === undefined ? {} : { input: (params: unknown) => telemetry.input?.(params as TParams) ?? {} }),
		...(telemetry.result === undefined ? {} : {
			result: (params: unknown, result: TelemetryResult<unknown>) => telemetry.result?.(params as TParams, result as TelemetryResult<TDetails>) ?? {},
		}),
	};
}

function runtimeKey(pi: TelemetryPi): object {
	try { return isObject(pi.events) ? pi.events : pi; } catch { return pi; }
}

function sharedService(runtime: object): TelemetryService | undefined {
	try {
		const value: unknown = Reflect.get(runtime, SERVICE_SLOT);
		return isTelemetryService(value) ? value : undefined;
	} catch { return undefined; }
}

function isTelemetryService(value: unknown): value is TelemetryService {
	return isObject(value) && ["attach", "onToolExecutionEnd", "prepared", "registerTool"]
		.every((method) => typeof Reflect.get(value, method) === "function");
}

function installSharedService(runtime: object, service: TelemetryService): boolean {
	try {
		Object.defineProperty(runtime, SERVICE_SLOT, { value: service, configurable: true });
		return true;
	} catch { return false; }
}

function releaseSharedService(service: TelemetryService): void {
	const runtime = runtimeByService.get(service);
	if (runtime === undefined) return;
	try { if (Reflect.get(runtime, SERVICE_SLOT) === service) Reflect.deleteProperty(runtime, SERVICE_SLOT); } catch {}
	fallbackServices.delete(runtime);
	runtimeByService.delete(service);
}

function safeAllTools(pi: Pick<TelemetryPi, "getAllTools">): ReturnType<TelemetryPi["getAllTools"]> {
	try { return pi.getAllTools(); } catch { return []; }
}

function optionalThinking(pi: Pick<TelemetryPi, "getThinkingLevel">): { thinking?: string } {
	try { return { thinking: pi.getThinkingLevel() }; } catch { return {}; }
}

function safeBranch(ctx: ExtensionContext): ReturnType<ExtensionContext["sessionManager"]["getBranch"]> {
	try { return ctx.sessionManager.getBranch(); } catch { return []; }
}

function safeSessionId(ctx: ExtensionContext): string {
	try { return ctx.sessionManager.getSessionId(); } catch { return "unknown"; }
}

function clone<T>(value: T): T {
	return structuredClone(value);
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
