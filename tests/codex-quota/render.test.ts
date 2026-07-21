import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderCodexQuota, renderCodexQuotaError } from "../../src/codex-quota/render.js";
import { CodexQuotaError, type CodexQuotaSnapshot } from "../../src/codex-quota/types.js";

describe("codex quota renderer", () => {
	it("展示 ASCII 进度条、窗口重置和重置卡详细信息", () => {
		const output = renderCodexQuota(snapshot(), 100).join("\n");
		expect(output).toContain("[#####---------------] 25% remaining");
		expect(output).toContain("resets 2026-07-13 08:00:00");
		expect(output).toContain("Expires in 7d");
		expect(output).toContain("2026-07-01 08:00:00");
		expect(output).toContain("2026-07-13 08:00:00");
		expect(output).not.toContain("Full reset");
		expect(output).not.toContain("Type codexRateLimits");
		expect(output).not.toContain("Description Free reset");
		expect(output).not.toContain("credit-1");
		expect(output).not.toMatch(/[\u4e00-\u9fff]/);
	});

	it("窄屏限制每行宽度并渲染错误", () => {
		const lines = renderCodexQuota(snapshot(), 42);
		expect(lines.every((line) => visibleWidth(line) <= 42)).toBe(true);
		const error = renderCodexQuotaError(new CodexQuotaError("timeout", "secret details"), 42).join("\n");
		expect(error).toContain("request timed out");
		expect(error).not.toMatch(/[\u4e00-\u9fff]/);
		expect(error).not.toContain("secret details");
	});

	it("长文本会自动折行，不会裁剪尾部", () => {
		const data = snapshot();
		const bucket = data.buckets[0];
		if (bucket === undefined) {
			throw new Error("snapshot bucket missing");
		}
		data.buckets[0] = {
			id: `${"quota".repeat(20)}ZZZZ_END`,
			name: bucket.name,
			planType: bucket.planType,
			primary: bucket.primary,
			secondary: bucket.secondary,
			credits: bucket.credits,
		};
		const lines = renderCodexQuota(data, 48);
		expect(lines.join(" ")).toContain("ZZZZ_END");
		expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
	});
});

function snapshot(): CodexQuotaSnapshot {
	return {
		generatedAt: new Date("2026-07-06T00:00:00Z"),
		timeZone: "Asia/Shanghai",
		buckets: [{
			id: "codex",
			name: "Codex",
			planType: "pro",
			primary: { usedPercent: 75, windowDurationMins: 10080, resetsAt: new Date("2026-07-13T00:00:00Z") },
			secondary: undefined,
			credits: { hasCredits: true, unlimited: false, balance: "10" },
		}],
		resetCredits: {
			availableCount: 1,
			credits: [{
				id: "credit-1",
				resetType: "codexRateLimits",
				status: "available",
				grantedAt: new Date("2026-07-01T00:00:00Z"),
				expiresAt: new Date("2026-07-13T00:00:00Z"),
				title: "Full reset",
				description: "Free reset",
			}],
		},
	};
}
