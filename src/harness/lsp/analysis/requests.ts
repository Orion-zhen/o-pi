import type { CodeAnalysisStatus, CodeFeatureResult } from "../../code-index/types.ts";
import type { LspRequestOptions } from "../types.ts";
import { createOperationDeadline, waitUnlessAborted, type OperationDeadline } from "./deadline.ts";

/** 成功事实独立保留，覆盖状态按固定优先级聚合。 */
export function combinedStatus(statuses: readonly CodeAnalysisStatus[]): CodeAnalysisStatus {
	for (const status of ["timeout", "unavailable", "skipped", "unsupported"] as const) {
		if (statuses.includes(status)) return status;
	}
	return "ok";
}

/** 一次分析只计时一次，启动、排队、加载和协议请求共用剩余预算。 */
export class AnalysisRequests {
	private readonly operation: OperationDeadline;
	readonly options: LspRequestOptions & { signal: AbortSignal };

	constructor(signal: AbortSignal | undefined, timeoutMs: number) {
		this.operation = createOperationDeadline(signal, timeoutMs);
		this.options = { signal: this.operation.signal };
	}

	get signal(): AbortSignal { return this.operation.signal; }

	async run<T>(request: (options: LspRequestOptions & { signal: AbortSignal }) => Promise<T | undefined>): Promise<CodeFeatureResult<T>> {
		try {
			if (this.signal.aborted) return { status: "timeout" };
			const value = await waitUnlessAborted(request(this.options), this.signal);
			if (value !== undefined) return { status: "ok", value };
			return { status: this.signal.aborted ? "timeout" : "unavailable" };
		} catch (error) {
			if (this.signal.aborted) return { status: "timeout" };
			throw error;
		}
	}

	dispose(): void {
		this.operation.dispose();
	}
}
