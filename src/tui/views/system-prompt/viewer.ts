import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, visibleWidth } from "@earendil-works/pi-tui";
import { countTextTokensSync, type TokenCounterScope } from "../../../harness/token-counter.ts";
import { borderedPanelContentWidth, renderBorderedPanel, ScrollPosition } from "../../components/scroll-viewer.ts";

const MIN_BORDERED_PANEL_WIDTH = 4;
const VIEWER_BODY_ROWS_RATIO = 0.75;
const VIEWER_NON_BODY_ROWS = 5;

/** 只读滚动查看 system prompt；该组件只在 custom UI 生命周期内存在。 */
export class SystemPromptViewer implements Component {
	private readonly content: string;
	private readonly tokenCount: number;
	private scroll = new ScrollPosition();

	constructor(
		content: string,
		private readonly theme: Theme,
		private readonly getRows: () => number,
		private readonly done: () => void,
		tokenScope: TokenCounterScope = {},
	) {
		this.content = normalizeLineEndings(content);
		this.tokenCount = countTextTokensSync(this.content, tokenScope).tokens;
	}

	handleInput(data: string): void {
		this.scroll.handleInput(data, this.getBodyHeight(), this.done);
	}

	render(width: number): string[] {
		if (width < 1) return [];
		if (width < MIN_BORDERED_PANEL_WIDTH) return this.renderContent(width);

		const contentWidth = borderedPanelContentWidth(width);
		return renderBorderedPanel(this.renderContent(contentWidth), width, this.theme);
	}

	invalidate(): void {}

	private renderContent(width: number): string[] {
		const bodyHeight = this.getBodyHeight();
		const bodyLines = this.formatBody(width);
		this.scroll.clamp(bodyLines.length, bodyHeight);

		return [
			this.formatHeader(width, bodyLines.length, bodyHeight),
			this.fitLine(this.theme.fg("dim", "Read-only view. Up/Down/Page/Home/End scroll, Esc/q/Enter closes."), width),
			this.fitLine("", width),
			...this.formatVisibleBody(bodyLines, bodyHeight).map((line) => this.fitLine(line, width)),
		];
	}

	private getBodyHeight(): number {
		return Math.max(1, Math.floor(this.getRows() * VIEWER_BODY_ROWS_RATIO) - VIEWER_NON_BODY_ROWS);
	}

	private formatHeader(width: number, bodyLineCount: number, bodyHeight: number): string {
		const rawLineCount = this.content.split("\n").length;
		const title = this.theme.bold(`System prompt (${this.content.length} chars, ~${this.tokenCount} tokens, ${rawLineCount} lines)`);
		const position = bodyLineCount > bodyHeight
			? ` ${this.scroll.top + 1}-${Math.min(bodyLineCount, this.scroll.top + bodyHeight)}/${bodyLineCount}`
			: "";
		return this.fitLine(this.theme.fg("accent", title) + this.theme.fg("dim", position), width);
	}

	private formatVisibleBody(bodyLines: string[], bodyHeight: number): string[] {
		const visibleBody = bodyLines.slice(this.scroll.top, this.scroll.top + bodyHeight);
		while (visibleBody.length < bodyHeight) visibleBody.push("");
		return visibleBody;
	}

	private formatBody(width: number): string[] {
		const lines = this.content.split("\n");
		const numberWidth = String(lines.length).length;
		const textWidth = Math.max(1, width - numberWidth - 3);
		const formatted: string[] = [];

		lines.forEach((line, index) => {
			const wrapped = wrapByColumns(line.length > 0 ? line : " ", textWidth);
			const firstPrefix = `${String(index + 1).padStart(numberWidth, " ")} | `;
			const nextPrefix = `${" ".repeat(numberWidth)} | `;
			wrapped.forEach((part, partIndex) => {
				const prefix = partIndex === 0 ? firstPrefix : nextPrefix;
				formatted.push(this.theme.fg("dim", prefix) + part);
			});
		});

		return formatted;
	}

	private fitLine(content: string, width: number): string {
		return truncateToWidth(content, width, "", true);
	}
}

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

function wrapByColumns(text: string, width: number): string[] {
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;

	for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
		const segmentWidth = visibleWidth(segment);
		if (current && currentWidth + segmentWidth > width) {
			lines.push(current);
			current = "";
			currentWidth = 0;
		}

		if (segmentWidth > width) continue;
		current += segment;
		currentWidth += segmentWidth;
	}

	if (current) lines.push(current);
	return lines.length > 0 ? lines : [" "];
}
