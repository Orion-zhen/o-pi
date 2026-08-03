import type { LspFileOperations, LspMutationInput } from "../../lsp/file-hooks.js";
import type { LspDiagnosticsSummary } from "../../lsp/types.js";
import type { MutationPostProcessObserver } from "./progress.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

interface LspSubmission {
	order: number;
	input: LspMutationInput | undefined;
	operations: LspFileOperations;
	progress?: MutationPostProcessObserver;
	deferred: Deferred<LspDiagnosticsSummary | undefined>;
}

interface MutationCallState {
	settled: boolean;
	lsp?: LspSubmission;
}

interface MutationBatch {
	ids: readonly string[];
	started: Set<string>;
	calls: Map<string, MutationCallState>;
	mode?: "active" | "disabled";
	finalizing?: Promise<void>;
	ended: Set<string>;
}

export interface MutationBatchInvocation {
	lsp(
		input: LspMutationInput | undefined,
		operations: LspFileOperations,
		progress?: MutationPostProcessObserver,
	): Promise<LspDiagnosticsSummary | undefined>;
	settle(): void;
}

/** 协调同一并行工具批次中的文件提交，并在全部提交后统一执行增强处理。 */
export class MutationBatchCoordinator {
	private readonly batchesByCall = new Map<string, MutationBatch>();
	private nextSubmissionOrder = 0;
	private disposed = false;

	capture(toolCalls: readonly { id: string; name: string }[]): void {
		if (this.disposed) return;
		const ids = toolCalls.flatMap((call) => call.name === "write" || call.name === "edit" ? [call.id] : []);
		if (ids.length < 2) return;
		const batch: MutationBatch = {
			ids,
			started: new Set(),
			calls: new Map(ids.map((id) => [id, { settled: false }])),
			ended: new Set(),
		};
		for (const id of ids) this.batchesByCall.set(id, batch);
	}

	started(toolCallId: string): void {
		this.batchesByCall.get(toolCallId)?.started.add(toolCallId);
	}

	ended(toolCallId: string): void {
		const batch = this.batchesByCall.get(toolCallId);
		if (batch === undefined) return;
		batch.ended.add(toolCallId);
		this.settle(batch, toolCallId);
		if (batch.ended.size === batch.ids.length) this.remove(batch);
	}

	invocation(toolCallId: string): MutationBatchInvocation | undefined {
		const batch = this.batchesByCall.get(toolCallId);
		if (batch === undefined || this.disposed) return undefined;
		if (batch.mode === undefined) {
			// 并行模式会在首个执行函数前发出本批次全部启动事件；否则保持逐调用后处理，避免顺序模式互相等待。
			batch.mode = batch.started.size === batch.ids.length ? "active" : "disabled";
		}
		if (batch.mode === "disabled") return undefined;
		return {
			lsp: (input, operations, progress) => this.submitLsp(batch, toolCallId, input, operations, progress),
			settle: () => this.settle(batch, toolCallId),
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const batch of new Set(this.batchesByCall.values())) {
			for (const call of batch.calls.values()) {
				call.lsp?.deferred.resolve(undefined);
			}
		}
		this.batchesByCall.clear();
	}

	private submitLsp(
		batch: MutationBatch,
		toolCallId: string,
		input: LspMutationInput | undefined,
		operations: LspFileOperations,
		progress: MutationPostProcessObserver | undefined,
	): Promise<LspDiagnosticsSummary | undefined> {
		const call = batch.calls.get(toolCallId);
		if (call === undefined || this.disposed) return Promise.resolve(undefined);
		if (call.lsp !== undefined) return call.lsp.deferred.promise;
		const deferred = createDeferred<LspDiagnosticsSummary | undefined>();
		this.nextSubmissionOrder += 1;
		call.lsp = { order: this.nextSubmissionOrder, input, operations, ...(progress === undefined ? {} : { progress }), deferred };
		this.maybeFinalize(batch);
		return deferred.promise;
	}

	private settle(batch: MutationBatch, toolCallId: string): void {
		const call = batch.calls.get(toolCallId);
		if (call === undefined) return;
		call.settled = true;
		this.maybeFinalize(batch);
	}

	private maybeFinalize(batch: MutationBatch): void {
		if (this.disposed || batch.mode !== "active" || batch.finalizing !== undefined) return;
		const ready = batch.ids.every((id) => {
			const call = batch.calls.get(id);
			return call !== undefined && (call.settled || call.lsp !== undefined);
		});
		if (!ready) return;
		batch.finalizing = this.finalize(batch);
	}

	private async finalize(batch: MutationBatch): Promise<void> {
		const lsp = batch.ids.flatMap((id) => {
			const submission = batch.calls.get(id)?.lsp;
			return submission === undefined ? [] : [submission];
		}).sort((left, right) => left.order - right.order);
		await processLspSubmissions(lsp);
	}

	private remove(batch: MutationBatch): void {
		for (const id of batch.ids) {
			if (this.batchesByCall.get(id) === batch) this.batchesByCall.delete(id);
		}
	}
}

async function processLspSubmissions(submissions: readonly LspSubmission[]): Promise<void> {
	for (const submission of submissions) safeNotify(() => submission.progress?.lspStarted());
	const groups = groupByIdentity(submissions, (submission) => submission.operations);
	await Promise.all(Array.from(groups, async ([operations, grouped]) => {
		const buckets = deduplicate(grouped, (submission) => submission.input === undefined
			? undefined
			: `${submission.input.workspaceRoot}\0${submission.input.filePath}`);
		for (const bucket of buckets.skipped) completeLsp(bucket, undefined);
		const inputs = buckets.unique.map((bucket) => bucket.latest.input).filter((input): input is LspMutationInput => input !== undefined);
		let results: readonly (LspDiagnosticsSummary | undefined)[];
		try {
			results = operations.afterMutationBatch !== undefined
				? await operations.afterMutationBatch(inputs)
				: await Promise.all(inputs.map((input) => operations.afterMutation?.(input)));
		} catch {
			results = inputs.map(() => undefined);
		}
		for (let index = 0; index < buckets.unique.length; index += 1) {
			const result = results[index];
			for (const submission of buckets.unique[index]?.all ?? []) completeLsp(submission, result);
		}
	}));
}

function groupByIdentity<T, K>(items: readonly T[], keyFor: (item: T) => K): Map<K, T[]> {
	const groups = new Map<K, T[]>();
	for (const item of items) {
		const key = keyFor(item);
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [item]);
		else group.push(item);
	}
	return groups;
}

function deduplicate<T>(
	items: readonly T[],
	keyFor: (item: T) => string | undefined,
): { unique: Array<{ latest: T; all: T[] }>; skipped: T[] } {
	const keyed = new Map<string, { latest: T; all: T[] }>();
	const skipped: T[] = [];
	for (const item of items) {
		const key = keyFor(item);
		if (key === undefined) {
			skipped.push(item);
			continue;
		}
		const existing = keyed.get(key);
		if (existing === undefined) keyed.set(key, { latest: item, all: [item] });
		else {
			existing.latest = item;
			existing.all.push(item);
		}
	}
	return { unique: Array.from(keyed.values()), skipped };
}

function completeLsp(submission: LspSubmission, result: LspDiagnosticsSummary | undefined): void {
	safeNotify(() => submission.progress?.lspCompleted(result));
	submission.deferred.resolve(result);
}

function createDeferred<T>(): Deferred<T> {
	let resolvePromise: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function safeNotify(observer: () => void): void {
	try {
		observer();
	} catch {}
}
