import type { Theme } from "@earendil-works/pi-coding-agent";
import { BorderedScrollViewer } from "../tui/bordered-scroll-viewer.js";
import { renderCodexQuota, renderCodexQuotaError } from "./render.js";
import type { CodexQuotaSnapshot } from "./types.js";

const BODY_ROWS_RATIO = 0.72;

/** /quota 的只读 overlay；额度数据不会写入模型上下文或会话历史。 */
export class CodexQuotaViewer extends BorderedScrollViewer {
	constructor(
		private readonly result: CodexQuotaSnapshot | Error,
		theme: Pick<Theme, "fg">,
		getRows: () => number,
		done: () => void,
	) {
		super(theme, getRows, done, BODY_ROWS_RATIO, false);
	}

	protected renderLines(width: number): string[] {
		return this.result instanceof Error ? renderCodexQuotaError(this.result, width) : renderCodexQuota(this.result, width);
	}
}
