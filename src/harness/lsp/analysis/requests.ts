import type { CodeAnalysisStatus, CodeFeatureResult } from "../../code-index/types.ts";
import { providerEnabled } from "../protocol/features.ts";
import type { LspRequestOptions } from "../types.ts";
import { createOperationDeadline, waitUnlessAborted } from "./deadline.ts";

/** 成功事实独立保留，覆盖状态按固定优先级聚合。 */
export function combinedStatus(statuses: readonly CodeAnalysisStatus[]): CodeAnalysisStatus {
	for (const status of ["timeout", "unavailable", "skipped", "unsupported"] as const) {
		if (statuses.includes(status)) return status;
	}
	return "ok";
}

/** 每项独立计时，已知失败由边界返回空值。意外错误向上传播，取消由分析入口处理。 */
export class AnalysisRequests {
	constructor(
		readonly signal: AbortSignal | undefined,
		private readonly timeoutMs: number,
	) {}

	async run<T>(
		provider: unknown,
		request: (options: LspRequestOptions & { signal: AbortSignal }) => Promise<T | undefined>,
	): Promise<CodeFeatureResult<T>> {
		if (!providerEnabled(provider)) return { status: "unsupported" };
		const operation = createOperationDeadline(this.signal, this.timeoutMs);
		let timedOut = false;
		try {
			if (operation.signal.aborted) return { status: "unavailable" };
			const value = await waitUnlessAborted(request({
				...operation.requestOptions(),
				onTimeout: () => { timedOut = true; },
			}), operation.signal);
			if (value !== undefined) return { status: "ok", value };
			return { status: timedOut || operation.signal.aborted ? "timeout" : "unavailable" };
		} catch (error) {
			if (operation.signal.aborted) return { status: "timeout" };
			throw error;
		} finally {
			operation.dispose();
		}
	}
}
