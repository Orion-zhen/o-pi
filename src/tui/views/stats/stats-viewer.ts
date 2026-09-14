import type { Theme } from "@earendil-works/pi-coding-agent";
import { BorderedScrollViewer } from "../../components/scroll-viewer.ts";
import { renderStats } from "./render-stats.ts";
import type { StatsSnapshot } from "../../../harness/stats/types.ts";

const VIEWER_BODY_ROWS_RATIO = 0.8;

/** /stats 的只读滚动浮层；不修改输入框或会话历史。 */
export class StatsViewer extends BorderedScrollViewer {
	constructor(
		private readonly snapshot: StatsSnapshot,
		theme: Pick<Theme, "fg">,
		getRows: () => number,
		done: () => void,
	) {
		super(theme, getRows, done, VIEWER_BODY_ROWS_RATIO, true);
	}

	protected renderLines(width: number): string[] {
		return renderStats(this.snapshot, width);
	}
}
