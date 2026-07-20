import type { Theme } from "@earendil-works/pi-coding-agent";

import { BorderedScrollViewer } from "../tui/bordered-scroll-viewer.js";
import type { LiveTelemetryReport } from "./live.js";
import { renderLiveTelemetry } from "./render-live.js";

const VIEWER_BODY_ROWS_RATIO = 0.8;
const SECTION_HEADINGS = new Set([
	"会话信息",
	"工具调用",
	"编辑调用",
	"批次分析",
	"候选项排序（启发式）",
	"候选来源类别",
	"候选来源明细",
]);

/** /telemetry read-only current-session report. */
export class TelemetryViewer extends BorderedScrollViewer {
	private readonly headingTheme: Pick<Theme, "fg">;

	constructor(
		private readonly report: LiveTelemetryReport,
		theme: Pick<Theme, "fg">,
		getRows: () => number,
		done: () => void,
	) {
		super(theme, getRows, done, VIEWER_BODY_ROWS_RATIO, true);
		this.headingTheme = theme;
	}

	protected renderLines(width: number): string[] {
		return renderLiveTelemetry(this.report, width).map((line) => SECTION_HEADINGS.has(line) ? this.headingTheme.fg("mdHeading", line) : line);
	}
}
