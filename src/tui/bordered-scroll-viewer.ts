import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const BORDER_ROWS = 2;
const HORIZONTAL_FRAME_WIDTH = 4;

/** 只读行查看器共用的键盘、滚动和边框行为。 */
export abstract class BorderedScrollViewer implements Component {
	private scrollTop = 0;

	protected constructor(
		private readonly theme: Pick<Theme, "fg">,
		private readonly getRows: () => number,
		private readonly done: () => void,
		private readonly bodyRowsRatio: number,
		private readonly fillBody: boolean,
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
		if (width < HORIZONTAL_FRAME_WIDTH) return this.renderBody(width);
		return this.renderBorder(this.renderBody(width - HORIZONTAL_FRAME_WIDTH), width);
	}

	invalidate(): void {}

	protected abstract renderLines(width: number): string[];

	private renderBody(width: number): string[] {
		const widthLimit = Math.max(1, width);
		const lines = this.renderLines(width).flatMap((line) => wrapTextWithAnsi(line, widthLimit));
		const bodyHeight = this.getBodyHeight();
		this.clampScroll(lines.length, bodyHeight);
		const visibleCount = this.fillBody ? bodyHeight : Math.min(lines.length, bodyHeight);
		const visible = lines.slice(this.scrollTop, this.scrollTop + visibleCount);
		while (visible.length < visibleCount) visible.push("");
		return visible.map((line, index) => (index === 0 ? this.theme.fg("accent", line) : line));
	}

	private scrollBy(delta: number): void {
		this.scrollTop = Math.max(0, this.scrollTop + delta);
	}

	private clampScroll(totalLines: number, bodyHeight: number): void {
		this.scrollTop = Math.min(this.scrollTop, Math.max(0, totalLines - bodyHeight));
	}

	private getBodyHeight(): number {
		return Math.max(1, Math.floor(this.getRows() * this.bodyRowsRatio) - BORDER_ROWS);
	}

	private renderBorder(lines: string[], width: number): string[] {
		const innerWidth = width - 2;
		const contentWidth = Math.max(0, width - HORIZONTAL_FRAME_WIDTH);
		const border = (text: string) => this.theme.fg("border", text);
		const row = (line: string) => `${border("│")} ${truncateToWidth(line, contentWidth, "", true)} ${border("│")}`;
		return [border(`╭${"─".repeat(innerWidth)}╮`), ...lines.map(row), border(`╰${"─".repeat(innerWidth)}╯`)];
	}
}
