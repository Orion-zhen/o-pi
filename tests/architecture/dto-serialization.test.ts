import { describe, expect, it } from "vitest";

import { querySkillStatus } from "../../src/skill-context/state.js";
import { collectStatsSnapshot, type StatsQueryPort } from "../../src/stats/collector.js";
import { createLiveTelemetryReport } from "../../src/telemetry-report/live.js";
import { TelemetryService } from "../../src/telemetry/service.js";
import { UsageService } from "../../src/usage/service.js";

describe("adapter-facing DTO serialization", () => {
	it("stats 在无模型、空 session 和失败 prompt options 下仍为 JSON-safe", async () => {
		const port: StatsQueryPort = {
			cwd: "/repo",
			model: undefined,
			getEntries: () => [],
			getBranch: () => [],
			isUsingSubscription: () => false,
			isIdle: () => true,
			getContextUsage: () => undefined,
			getSystemPrompt: () => "",
			getSystemPromptOptions() {
				throw new Error("provider unavailable");
			},
			now: () => new Date("2026-07-31T00:00:00Z"),
		};
		const snapshot = await collectStatsSnapshot(port, {
			getActiveTools: () => [],
			getAllTools: () => [],
			getThinkingLevel: () => "off",
		});

		expect(snapshot.generatedAt).toBe("2026-07-31T00:00:00.000Z");
		expectJsonRoundTrip(snapshot);
	});

	it("usage 在所有 provider 认证失败时仍返回 JSON-safe 降级快照", async () => {
		const service = new UsageService({ clock: () => Date.parse("2026-07-31T00:00:00Z") });
		const snapshot = await service.load({
			modelRegistry: {
				async getProviderAuth() {
					throw new Error("provider unavailable");
				},
			},
		});

		expect(snapshot.providers.every((provider) => provider.status === "error")).toBe(true);
		expectJsonRoundTrip(snapshot);
	});

	it("未启用 telemetry 的 collector 与 live report 均为 JSON-safe", () => {
		const service = new TelemetryService({
			getAllTools: () => [],
			getThinkingLevel: () => "off",
		});
		const snapshot = service.snapshot();
		expect(snapshot).toMatchObject({ enabled: false, pending_calls: 0, records: [] });
		expectJsonRoundTrip(snapshot);
		expectJsonRoundTrip(createLiveTelemetryReport(snapshot, "2026-07-31T00:00:00.000Z"));
	});

	it("空 skill branch 仍为 JSON-safe", () => {
		const skills = querySkillStatus([]);

		expect(skills).toEqual({ skills: [] });
		expectJsonRoundTrip(skills);
	});
});

function expectJsonRoundTrip<T>(value: T): void {
	expect(structuredClone(value)).toEqual(value);
	expect(JSON.parse(JSON.stringify(value)) as unknown).toEqual(value);
}
