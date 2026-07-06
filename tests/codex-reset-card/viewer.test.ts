import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { CodexResetCardViewer } from "../../src/codex-reset-card/viewer.js";
import type { CodexResetCardSnapshot } from "../../src/codex-reset-card/types.js";

describe("codex reset card viewer", () => {
	it("Esc、q、Enter 关闭，渲染带边框浮层", () => {
		for (const key of ["q", "\x1b", "\r"]) {
			let closed = 0;
			const viewer = new CodexResetCardViewer(snapshot(), theme(), () => 10, () => {
				closed += 1;
			});

			viewer.handleInput(Key.down);
			expect(closed).toBe(0);
			viewer.handleInput(key);
			expect(closed).toBe(1);
		}

		const viewer = new CodexResetCardViewer(snapshot(), theme(), () => 10, () => {});
		const lines = viewer.render(80);
		expect(lines[0]).toBe(`╭${"─".repeat(78)}╮`);
		expect(lines.at(-1)).toBe(`╰${"─".repeat(78)}╯`);
		expect(lines.some((line) => line.includes("Codex Reset Cards"))).toBe(true);
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	it("内容较少时不补空行撑满终端高度", () => {
		const viewer = new CodexResetCardViewer(snapshot(), theme(), () => 40, () => {});

		expect(viewer.render(86)).toHaveLength(10);
	});
});

function theme(): Pick<Theme, "fg"> {
	return {
		fg: (_color: string, text: string) => text,
	};
}

function snapshot(): CodexResetCardSnapshot {
	return {
		timeZone: "Asia/Shanghai",
		generatedAt: new Date("2026-07-06T00:00:00Z"),
		cards: [{ issuedAt: new Date("2026-07-01T00:00:00Z"), expiresAt: new Date("2026-07-08T00:00:00Z"), usedAt: undefined }],
	};
}
