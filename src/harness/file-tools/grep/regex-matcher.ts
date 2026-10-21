import { WorkerTaskPool } from "../../worker-runtime/worker-task-pool.ts";
import { createTypeScriptWorker } from "../../worker-runtime/typescript-worker.ts";

export interface LineMatch { readonly start: number; readonly end: number }
export interface RegexRequest { readonly source: string; readonly lines: readonly string[] }

/** 普通文本留在当前线程，正则在可终止的 worker 中按批执行。 */
export class GrepLineMatcher {
	private readonly pool: WorkerTaskPool<RegexRequest, Array<LineMatch | undefined>> | undefined;

	constructor(private readonly regex: RegExp, literal: boolean) {
		if (!literal && /[.*+?^${}()|[\]\\]/u.test(regex.source)) {
			this.pool = new WorkerTaskPool({
				workerLimit: 2,
				workerName: "grep regex",
				createWorker: () => createTypeScriptWorker(new URL("./regex-worker.ts", import.meta.url)),
			});
		}
	}

	async match(lines: readonly string[], signal?: AbortSignal): Promise<Array<LineMatch | undefined>> {
		if (this.pool !== undefined) return this.pool.run({ source: this.regex.source, lines }, signal);
		return lines.map((line) => {
			const match = this.regex.exec(line);
			return match === null ? undefined : { start: match.index, end: match.index + match[0].length };
		});
	}

	dispose(): void { this.pool?.dispose(); }
}
