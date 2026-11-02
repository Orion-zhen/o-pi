import type { LoadLsp, LspMutationInput } from "../../lsp/file-operations.ts";
import type { LspDiagnosticsSummary } from "../../lsp/types.ts";

interface LspSubmission {
	order: number;
	input: LspMutationInput | undefined;
	deferred: PromiseWithResolvers<LspDiagnosticsSummary | undefined>;
}

interface MutationCall {
	id: string;
	state: { kind: "pending" } | { kind: "submitted"; submission: LspSubmission } | { kind: "settled" };
}

interface MutationBatch {
	calls: readonly MutationCall[];
	started: number;
	mode: "pending" | "active" | "disabled" | "finalizing";
}

export interface MutationBatchInvocation {
	lsp(input: LspMutationInput | undefined): Promise<LspDiagnosticsSummary | undefined>;
	settle(): void;
}

/** 协调同一并行工具批次中的文件提交，并在全部提交后统一执行增强处理。 */
export class MutationBatchCoordinator {
	private readonly calls = new Map<string, { batch: MutationBatch; call: MutationCall }>();
	private nextSubmissionOrder = 0;
	private disposed = false;

	constructor(private readonly loadLsp: LoadLsp) {}

	capture(toolCalls: readonly { id: string; name: string }[]): void {
		if (this.disposed) return;
		const calls: MutationCall[] = toolCalls
			.filter((call) => call.name === "write" || call.name === "edit")
			.map(({ id }) => ({ id, state: { kind: "pending" } }));
		if (calls.length < 2) return;
		const batch: MutationBatch = { calls, started: 0, mode: "pending" };
		for (const call of calls) this.calls.set(call.id, { batch, call });
	}

	started(toolCallId: string): void {
		const entry = this.calls.get(toolCallId);
		if (entry !== undefined) entry.batch.started += 1;
	}

	ended(toolCallId: string): void {
		const entry = this.calls.get(toolCallId);
		if (entry === undefined) return;
		this.calls.delete(toolCallId);
		this.settle(entry.batch, entry.call);
	}

	invocation(toolCallId: string): MutationBatchInvocation | undefined {
		const entry = this.calls.get(toolCallId);
		if (entry === undefined) return undefined;
		const { batch, call } = entry;
		if (batch.mode === "pending") {
			// 并行执行在首个 execute 前发出全部启动事件，顺序执行不能互相等待。
			batch.mode = batch.started === batch.calls.length ? "active" : "disabled";
		}
		if (batch.mode === "disabled") return undefined;
		return {
			lsp: (input) => {
				if (this.disposed) return Promise.resolve(undefined);
				const deferred = Promise.withResolvers<LspDiagnosticsSummary | undefined>();
				call.state = { kind: "submitted", submission: { order: this.nextSubmissionOrder++, input, deferred } };
				this.maybeFinalize(batch);
				return deferred.promise;
			},
			settle: () => this.settle(batch, call),
		};
	}

	dispose(): void {
		this.disposed = true;
		for (const { call } of this.calls.values()) {
			if (call.state.kind === "submitted") call.state.submission.deferred.resolve(undefined);
		}
		this.calls.clear();
	}

	private settle(batch: MutationBatch, call: MutationCall): void {
		call.state = { kind: "settled" };
		this.maybeFinalize(batch);
	}

	private maybeFinalize(batch: MutationBatch): void {
		if (this.disposed || batch.mode !== "active" || batch.calls.some((call) => call.state.kind === "pending")) return;
		batch.mode = "finalizing";
		const submissions = batch.calls.flatMap((call) => call.state.kind === "submitted" ? [call.state.submission] : [])
			.sort((left, right) => left.order - right.order);
		void processLspSubmissions(submissions, this.loadLsp);
	}
}

async function processLspSubmissions(submissions: readonly LspSubmission[], loadLsp: LoadLsp): Promise<void> {
	const files = new Map<string, { input: LspMutationInput; submissions: LspSubmission[] }>();
	for (const submission of submissions) {
		const input = submission.input;
		if (input === undefined) {
			submission.deferred.resolve(undefined);
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
	try {
		const results = await (await loadLsp()).afterMutationBatch(batches.map((file) => file.input));
		for (const [index, file] of batches.entries()) {
			for (const submission of file.submissions) submission.deferred.resolve(results[index]);
		}
	} catch (error) {
		// 批处理只转交失败，是否隔离由每次文件调用的增强边界决定。
		for (const file of batches) {
			for (const submission of file.submissions) submission.deferred.reject(error);
		}
	}
}
