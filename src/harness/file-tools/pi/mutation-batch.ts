import type { LoadLsp, LspMutationInput } from "../../lsp/file-operations.ts";
import type { LspDiagnosticsSummary } from "../../lsp/types.ts";
import type { MutationPostProcessObserver } from "./progress.ts";

interface LspSubmission {
	order: number;
	input: LspMutationInput | undefined;
	progress?: MutationPostProcessObserver;
	deferred: PromiseWithResolvers<LspDiagnosticsSummary | undefined>;
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
		progress?: MutationPostProcessObserver,
	): Promise<LspDiagnosticsSummary | undefined>;
	settle(): void;
}

/** 协调同一并行工具批次中的文件提交，并在全部提交后统一执行增强处理。 */
export class MutationBatchCoordinator {
	private readonly batchesByCall = new Map<string, MutationBatch>();
	private nextSubmissionOrder = 0;
	private disposed = false;

	constructor(private readonly loadLsp: LoadLsp) {}

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
			lsp: (input, progress) => this.submitLsp(batch, toolCallId, input, progress),
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
		progress: MutationPostProcessObserver | undefined,
	): Promise<LspDiagnosticsSummary | undefined> {
		const call = batch.calls.get(toolCallId);
		if (call === undefined || this.disposed) return Promise.resolve(undefined);
		if (call.lsp !== undefined) return call.lsp.deferred.promise;
		const deferred = Promise.withResolvers<LspDiagnosticsSummary | undefined>();
		this.nextSubmissionOrder += 1;
		call.lsp = { order: this.nextSubmissionOrder, input, ...(progress === undefined ? {} : { progress }), deferred };
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
		await processLspSubmissions(lsp, this.loadLsp);
	}

	private remove(batch: MutationBatch): void {
		for (const id of batch.ids) {
			if (this.batchesByCall.get(id) === batch) this.batchesByCall.delete(id);
		}
	}
}

async function processLspSubmissions(submissions: readonly LspSubmission[], loadLsp: LoadLsp): Promise<void> {
	const files = new Map<string, { input: LspMutationInput; submissions: LspSubmission[] }>();
	for (const submission of submissions) {
		safeNotify(() => submission.progress?.lspStarted());
		const input = submission.input;
		if (input === undefined) {
			completeLsp(submission, undefined);
			continue;
		}
		const key = `${input.workspaceRoot}\0${input.filePath}`;
		const file = files.get(key);
		if (file === undefined) files.set(key, { input, submissions: [submission] });
		else {
			file.input = input;
			file.submissions.push(submission);
		}
	}
	if (files.size === 0) return;
	const batches = [...files.values()];
	let results: readonly (LspDiagnosticsSummary | undefined)[];
	try {
		results = await (await loadLsp()).afterMutationBatch(batches.map((file) => file.input));
	} catch {
		// 文件已经提交，诊断失败只影响增强结果。
		results = [];
	}
	for (const [index, file] of batches.entries()) {
		for (const submission of file.submissions) completeLsp(submission, results[index]);
	}
}

function completeLsp(submission: LspSubmission, result: LspDiagnosticsSummary | undefined): void {
	safeNotify(() => submission.progress?.lspCompleted(result));
	submission.deferred.resolve(result);
}

function safeNotify(observer: () => void): void {
	try {
		observer();
	} catch {}
}
