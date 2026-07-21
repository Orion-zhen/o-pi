import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { BorderedScrollViewer } from "../../src/tui/bordered-scroll-viewer.js";

class OverflowLineViewer extends BorderedScrollViewer {
	constructor(content: string, getRows = () => 30, onClose: () => void = () => {}) {
		super(theme(), getRows, onClose, 1, true);
		this.content = content;
	}

	protected renderLines(_width: number): string[] {
		return [this.content];
	}

	private readonly content: string;
}

describe("bordered scroll viewer", () => {
	it("对超长行自动折行而不是裁剪", () => {
		const content = `${"A".repeat(128)} ZZZZ_END`;
		const viewer = new OverflowLineViewer(content);
		const lines = viewer.render(30);

		expect(lines.some((line) => visibleWidth(line) > 30)).toBe(false);
		expect(lines.join("\n")).toContain("ZZZZ_END");
		expect(lines.at(0)).toMatch(/\x1b\[/u);
	});

	it("Esc、q、Enter 可关闭", () => {
		let closed = 0;
		const viewer = new OverflowLineViewer("x", () => 10, () => {
			closed += 1;
		});
		viewer.handleInput(Key.up);
		viewer.handleInput("q");
		expect(closed).toBe(1);
	});
});

function theme(): Pick<Theme, "fg"> {
	return {
		fg(_name: string, text: string): string {
			return `\x1b[31m${text}\x1b[0m`;
		},
	};
}
