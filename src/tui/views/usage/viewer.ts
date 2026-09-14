import type { Theme } from "@earendil-works/pi-coding-agent";
import { BorderedScrollViewer } from "../../components/scroll-viewer.ts";
import { renderUsage, renderUsageCancelled } from "../../../harness/usage/presentation/render.ts";
import type { UsageSnapshot } from "../../../harness/usage/types.ts";

const BODY_ROWS_RATIO = 0.72;

/** /usage 的只读 overlay。查询结果不会写入模型上下文或会话历史。 */
export class UsageViewer extends BorderedScrollViewer {
	constructor(
		private readonly result: UsageSnapshot | "aborted",
		private readonly usageTheme: Pick<Theme, "fg" | "bold">,
		getRows: () => number,
		done: () => void,
	) {
		super(usageTheme, getRows, done, BODY_ROWS_RATIO, false);
	}

	protected renderLines(width: number): string[] {
		return this.result === "aborted"
			? renderUsageCancelled(width)
			: renderUsage(this.result, width, {
				formatProviderHeading: (heading) => this.usageTheme.fg("accent", this.usageTheme.bold(heading)),
			});
	}
}
