import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { formatStartupBanner } from "../../src/tui/banner.js";
import { defaultTuiConfig } from "../../src/tui/config.js";
import { footerSnapshot, plainTheme } from "./fixtures.js";

const snapshot = footerSnapshot({ tokens: 0, contextWindow: 200_000, percent: 0 });

describe("regular startup banner", () => {
	it.each([120, 80, 36])("宽度 %i 下不越界", (width) => {
		const lines = formatStartupBanner(snapshot, defaultTuiConfig().home, width, plainTheme());
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it("缺少可选状态时不输出占位脏值", () => {
		const output = formatStartupBanner(
			{ cwd: "/repo", status: "ready" },
			defaultTuiConfig().home,
			120,
			plainTheme(),
		).join("\n");
		expect(output).not.toMatch(/undefined|null/);
	});
});
