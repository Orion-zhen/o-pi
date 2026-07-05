import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { renderStats } from "./render-stats.js";
import type { StatsSnapshot } from "./types.js";

const VIEWER_BODY_ROWS_RATIO = 0.8;
const VIEWER_BORDER_ROWS = 2;
const VIEWER_HORIZONTAL_FRAME_WIDTH = 4;

/** /stats 的只读滚动浮层；不修改输入框或会话历史。 */
export class StatsViewer implements Component {
	private scrollTop = 0;

	constructor(
		private readonly snapshot: StatsSnapshot,
		private readonly theme: Pick<Theme, "fg">,
		private readonly getRows: () => number,
		private readonly done: () => void,
	) {}

	handleInput(data: string): void {
		const pageSize = this.getBodyHeight();
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, "q")) {
			this.done();
			return;
		}

		if (matchesKey(data, Key.up)) this.scrollBy(-1);
		else if (matchesKey(data, Key.down)) this.scrollBy(1);
		else if (matchesKey(data, Key.pageUp)) this.scrollBy(-pageSize);
		else if (matchesKey(data, Key.pageDown)) this.scrollBy(pageSize);
		else if (matchesKey(data, Key.home)) this.scrollTop = 0;
		else if (matchesKey(data, Key.end)) this.scrollTop = Number.MAX_SAFE_INTEGER;
	}

	render(width: number): string[] {
		if (width < 1) return [];
		if (width < VIEWER_HORIZONTAL_FRAME_WIDTH) return this.renderBody(width);
		const contentWidth = width - VIEWER_HORIZONTAL_FRAME_WIDTH;
		const visible = this.renderBody(contentWidth);
		return this.renderBorder(visible, width);
	}

	private renderBody(width: number): string[] {
		const lines = renderStats(this.snapshot, width);
		const bodyHeight = this.getBodyHeight();
		this.clampScroll(lines.length, bodyHeight);
		const visible = lines.slice(this.scrollTop, this.scrollTop + bodyHeight);
		while (visible.length < bodyHeight) visible.push("");
		return visible.map((line, index) => (index === 0 ? this.theme.fg("accent", line) : line));
	}

	invalidate(): void {}

	private scrollBy(delta: number): void {
		this.scrollTop = Math.max(0, this.scrollTop + delta);
	}

	private clampScroll(totalLines: number, bodyHeight: number): void {
		const maxScrollTop = Math.max(0, totalLines - bodyHeight);
		this.scrollTop = Math.min(Math.max(0, this.scrollTop), maxScrollTop);
	}

	private getBodyHeight(): number {
		return Math.max(1, Math.floor(this.getRows() * VIEWER_BODY_ROWS_RATIO) - VIEWER_BORDER_ROWS);
	}

	/** overlay 自身无默认边框；这里手动画框，避免 /stats 内容和背景窗口混在一起。 */
	private renderBorder(lines: string[], width: number): string[] {
		const innerWidth = width - 2;
		const contentWidth = Math.max(0, width - VIEWER_HORIZONTAL_FRAME_WIDTH);
		const border = (text: string) => this.theme.fg("border", text);
		const row = (line: string) => {
			const content = truncateToWidth(line, contentWidth, "");
			return `${border("│")} ${padEnd(content, contentWidth)} ${border("│")}`;
		};
		return [border(`╭${"─".repeat(innerWidth)}╮`), ...lines.map(row), border(`╰${"─".repeat(innerWidth)}╯`)];
	}
}

function padEnd(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
