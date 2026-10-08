import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const BORDER_ROWS = 2;
const HORIZONTAL_FRAME_WIDTH = 4;

export function borderedPanelContentWidth(width: number): number {
	return Math.max(0, width - HORIZONTAL_FRAME_WIDTH);
}

/** 使用 TUI 通用圆角边框渲染面板。 */
export function renderBorderedPanel(
	lines: readonly string[],
	width: number,
	theme: Pick<Theme, "fg">,
): string[] {
	const innerWidth = width - 2;
	const contentWidth = borderedPanelContentWidth(width);
	const border = (text: string) => theme.fg("border", text);
	const row = (line: string) => `${border("│")} ${truncateToWidth(line, contentWidth, "", true)} ${border("│")}`;
	return [border(`╭${"─".repeat(innerWidth)}╮`), ...lines.map(row), border(`╰${"─".repeat(innerWidth)}╯`)];
}

/** 只读查看器共享滚动位置和键盘操作，布局由调用方保留。 */
export class ScrollPosition {
	top = 0;

	handleInput(data: string, pageSize: number, done: () => void): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, "q")) done();
		else if (matchesKey(data, Key.up)) this.top = Math.max(0, this.top - 1);
		else if (matchesKey(data, Key.down)) this.top++;
		else if (matchesKey(data, Key.pageUp)) this.top = Math.max(0, this.top - pageSize);
		else if (matchesKey(data, Key.pageDown)) this.top += pageSize;
		else if (matchesKey(data, Key.home)) this.top = 0;
		else if (matchesKey(data, Key.end)) this.top = Number.MAX_SAFE_INTEGER;
	}

	clamp(totalLines: number, bodyHeight: number): void {
		this.top = Math.min(this.top, Math.max(0, totalLines - bodyHeight));
	}
}

/** 只读行查看器共用的键盘、滚动和边框行为。 */
export abstract class BorderedScrollViewer implements Component {
	private scroll = new ScrollPosition();

	protected constructor(
		private readonly theme: Pick<Theme, "fg">,
		private readonly getRows: () => number,
		private readonly done: () => void,
		private readonly bodyRowsRatio: number,
		private readonly fillBody: boolean,
	) {}

	handleInput(data: string): void {
		this.scroll.handleInput(data, this.getBodyHeight(), this.done);
	}

	render(width: number): string[] {
		if (width < 1) return [];
		if (width < HORIZONTAL_FRAME_WIDTH) return this.renderBody(width);
		return renderBorderedPanel(this.renderBody(borderedPanelContentWidth(width)), width, this.theme);
	}

	invalidate(): void {}

	protected abstract renderLines(width: number): string[];

	private renderBody(width: number): string[] {
		const widthLimit = Math.max(1, width);
		const lines = this.renderLines(width).flatMap((line) => wrapTextWithAnsi(line, widthLimit));
		const bodyHeight = this.getBodyHeight();
		this.scroll.clamp(lines.length, bodyHeight);
		const visibleCount = this.fillBody ? bodyHeight : Math.min(lines.length, bodyHeight);
		const visible = lines.slice(this.scroll.top, this.scroll.top + visibleCount);
		while (visible.length < visibleCount) visible.push("");
		return visible.map((line, index) => (index === 0 ? this.theme.fg("accent", line) : line));
	}

	private getBodyHeight(): number {
		return Math.max(1, Math.floor(this.getRows() * this.bodyRowsRatio) - BORDER_ROWS);
	}
}
