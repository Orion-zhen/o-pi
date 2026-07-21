import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { CodexQuotaViewer } from "../../src/codex-quota/viewer.js";
import type { CodexQuotaSnapshot } from "../../src/codex-quota/types.js";

describe("codex quota viewer", () => {
	it("提供 overlay 所需的边框、滚动和关闭行为", () => {
		let closed = 0;
		const viewer = new CodexQuotaViewer(snapshot(), theme(), () => 20, () => {
			closed += 1;
		});

		viewer.handleInput("q");
		expect(closed).toBe(1);
		const lines = viewer.render(80);
		expect(lines[0]).toBe(`╭${"─".repeat(78)}╮`);
		expect(lines.at(-1)).toBe(`╰${"─".repeat(78)}╯`);
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});
});

function theme(): Pick<Theme, "fg"> {
	return { fg: (_color: string, text: string) => text };
}

function snapshot(): CodexQuotaSnapshot {
	return {
		generatedAt: new Date("2026-07-06T00:00:00Z"),
		timeZone: "UTC",
		buckets: [],
		resetCredits: undefined,
	};
}
