import type { StatsSnapshot } from "../../src/harness/stats/types.ts";
import type { UsageSnapshot } from "../../src/harness/usage/types.ts";
import { createLiveTelemetryReport } from "../../src/harness/telemetry-report/live.ts";
import type { CallRecord } from "../../src/harness/telemetry/types.ts";

export const statsReport: StatsSnapshot = {
	generatedAt: "2026-09-15T10:00:00Z",
	session: { modelId: "Claude Sonnet", modelProvider: "anthropic", thinkingLevel: "high", usingSubscription: true, status: "ready", userTurns: 12, assistantTurns: 24, cwd: "/workspace/project" },
	usage: { inputTokens: 12000, outputTokens: 3000, cacheReadTokens: 32000, cacheWriteTokens: 3000, totalObservedTokens: 50000, costUsd: 0.245, lastTurnTokens: 5000, lastCostUsd: 0.012, averageTokensPerAssistantTurn: 2083 },
	cache: { latestHitRate: 90, totalHitRate: 80, readWriteRatio: 10.7 },
	context: { totalTokens: 50000, contextWindow: 200000, percent: 25, remainingTokens: 150000, confidence: "mixed", notes: [], items: [
		{ id: "system", label: "system prompt", tokens: 10000, share: 20, estimated: true },
		{ id: "conversation_history", label: "conversation history", tokens: 15000, share: 30, estimated: true },
		{ id: "tool_outputs", label: "tool outputs", tokens: 25000, share: 50, estimated: true },
	] },
	tools: { calls: 24, successes: 23, failures: 1, activeCount: 8, totalCount: 10, byName: [
		{ name: "read", calls: 16, failures: 0, outputChars: 48000 }, { name: "edit", calls: 8, failures: 1, outputChars: 2600 },
	] },
};

export const usageReport: UsageSnapshot = {
	generatedAt: "2026-09-15T10:00:00Z", timeZone: "Asia/Shanghai",
	providers: [
		{ id: "anthropic", name: "Claude", status: "ok", plan: "Max", details: [], resetCredits: undefined, windows: [
			{ label: "5 小时", usedPercent: 35, windowDurationMins: 300, resetsAt: "2026-09-15T12:00:00Z" },
			{ label: "每周", usedPercent: 92, windowDurationMins: 10080, resetsAt: "2026-09-20T00:00:00Z" },
			{ label: "额外额度", usedPercent: undefined, windowDurationMins: undefined, resetsAt: undefined },
		] },
		{ id: "openai-codex", name: "Codex", status: "ok", plan: "Pro", windows: [{ label: "每周", usedPercent: 100, windowDurationMins: 10080, resetsAt: "2026-09-20T00:00:00Z" }], details: [{ label: "计费模式", value: "订阅" }], resetCredits: { availableCount: 3, credits: [
			{ status: "available", grantedAt: "2026-08-22T00:02:00Z", expiresAt: "2026-09-21T00:02:00Z" },
			{ status: "available", grantedAt: "2026-09-04T02:06:00Z", expiresAt: "2026-10-04T02:06:00Z" },
			{ status: "available", grantedAt: "2026-09-05T04:21:00Z", expiresAt: "2026-10-05T04:21:00Z" },
		] } },
		{ id: "kimi-coding", name: "Kimi", status: "error", error: { code: "timeout" } },
		{ id: "xai", name: "Grok", status: "not_logged_in" },
	],
};

const call = (index: number, tool: string, status: "success" | "error", duration: number): CallRecord => ({
	type: "call", run_id: "run-test", at: "2026-09-15T10:00:00Z", call_id: `call-${index}`, call_index: index,
	tool, status, duration_ms: duration, started_at: "2026-09-15T09:59:00Z", ended_at: "2026-09-15T10:00:00Z", output_chars: 500,
});
export const telemetryReport = createLiveTelemetryReport({
	enabled: true, pending_calls: 1, run_id: "run-test", session_id: "session-test",
	records: [
		{ type: "run", run_id: "run-test", session_id: "session-test", at: "2026-09-15T10:00:00Z", reason: "startup", cwd: "/workspace/project" },
		call(1, "read", "success", 100), call(2, "read", "success", 300),
		{ ...call(3, "edit", "error", 50), error: { code: "old_not_found" } },
	],
}, "2026-09-15T10:00:00Z");
