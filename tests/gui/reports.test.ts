import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { StatsReport } from "../../src/gui/ui/reports/stats-report.tsx";
import { ResetCredits, UsageReport } from "../../src/gui/ui/reports/usage-report.tsx";
import { TelemetryReport } from "../../src/gui/ui/reports/telemetry-report.tsx";
import { createLiveTelemetryReport } from "../../src/harness/telemetry-report/live.ts";
import { statsReport, telemetryReport, usageReport } from "./report-fixtures.ts";

const documentOf = (element: Parameters<typeof renderToStaticMarkup>[0]) => parseHTML(renderToStaticMarkup(element)).document;

describe("统计报告可视化", () => {
	it("会话统计区分累计用量、上下文占比和缓存命中率", () => {
		const doc = documentOf(createElement(StatsReport, { value: statsReport }));
		expect(doc.querySelector("pre")).toBeNull();
		expect(doc.querySelector('[aria-label="上下文占用"]')?.getAttribute("value")).toBe("25");
		expect(doc.querySelector('[aria-label="累计缓存命中率"]')?.getAttribute("value")).toBe("80");
		expect(doc.querySelector('[aria-label="工具输出"]')?.getAttribute("value")).toBe("50");
		expect(doc.querySelector(".report-metrics")?.textContent).toContain("50,000");
		expect(doc.querySelector(".report-metrics")?.textContent).toContain("非实际账单");
	});

	it("缺失的上下文用量不伪装为零占用", () => {
		const doc = documentOf(createElement(StatsReport, { value: { ...statsReport, context: { confidence: "estimated", items: [], notes: [] } } }));
		expect(doc.querySelector('[aria-label="上下文占用"]')).toBeNull();
		expect(doc.querySelector('[aria-label="上下文窗口"]')?.textContent).toContain("暂无数据");
	});

	it("套餐剩余额度、耗尽、未知窗口和独立服务商错误分别展示", () => {
		const doc = documentOf(createElement(UsageReport, { value: usageReport }));
		expect(doc.querySelector("pre")).toBeNull();
		expect(doc.querySelector('[aria-label="5 小时"]')?.getAttribute("value")).toBe("65");
		expect(doc.querySelector('[aria-label="Codex"] meter')?.getAttribute("value")).toBe("0");
		expect(doc.querySelector('[aria-label="Claude"]')?.textContent).toContain("用量暂不可用");
		expect(doc.querySelector('[aria-label="Kimi"]')?.textContent).toContain("查询超时");
		expect(doc.querySelector('[aria-label="Grok"]')).toBeNull();
		expect(doc.querySelector(".report-intro")).toBeNull();
		expect(doc.querySelector('[aria-label="Claude"]')?.textContent).toContain("20:00");
		expect(doc.querySelector(".reset-credits header")?.textContent).toContain("3 次可用");
		expect(doc.querySelectorAll(".reset-credits li")).toHaveLength(3);
		expect(doc.querySelector(".reset-credits li")?.textContent).toContain("5 天 14 小时");
		expect(doc.querySelector('[aria-label="Codex"] .report-metrics')).toBeNull();
		expect(doc.querySelector("details")).toBeNull();
	});

	it("额度窗口仅展示剩余额度和重置时间", () => {
		const doc = documentOf(createElement(UsageReport, { value: usageReport }));
		const windows = [...doc.querySelectorAll(".report-usage-window")];
		expect(windows).toHaveLength(4);
		for (const window of windows) {
			expect(window.textContent).not.toContain("已使用");
			expect(window.textContent).not.toContain("计量周期");
			expect(window.querySelector("dt")?.textContent).toBe("重置时间");
		}
		expect(doc.querySelector(".usage-reset time")?.getAttribute("dateTime")).toBe("2026-09-15T12:00:00Z");
		expect(doc.querySelector(".usage-reset time")?.textContent).toContain("20:00");
		expect(windows[2]?.querySelector(".usage-reset dd")?.textContent).toBe("未提供");
	});

	it.each([
		["2026-09-18T14:20:00Z", "3 天 4 小时"],
		["2026-09-15T12:35:00Z", "2 小时 35 分钟"],
		["2026-09-15T10:25:00Z", "25 分钟"],
		["2026-09-15T10:00:30Z", "不足 1 分钟"],
		["2026-09-15T10:00:00Z", "已到期"],
		["2026-09-14T10:00:00Z", "已到期"],
		[undefined, "无到期时间"],
	])("重置额度到期时间 %s 显示为 %s", (expiresAt, expected) => {
		const doc = documentOf(createElement(ResetCredits, {
			value: { availableCount: 1, credits: [{ status: "available", grantedAt: "2026-09-01T00:00:00Z", expiresAt }] },
			timeZone: "Asia/Shanghai", generatedAt: "2026-09-15T10:00:00Z",
		}));
		expect(doc.querySelector("time")?.textContent).toContain("08:00");
		expect(doc.querySelector(".reset-credit-remaining dd")?.textContent).toBe(expected);
		expect([...doc.querySelectorAll("dt")].map((item) => item.textContent)).toEqual(["发放时间", "到期时间", "距到期"]);
	});

	it("没有已登录套餐时仅显示空状态，不展示服务商列表", () => {
		const doc = documentOf(createElement(UsageReport, { value: { ...usageReport, providers: [{ id: "xai", name: "Grok", status: "not_logged_in" }] } }));
		expect(doc.querySelector(".report-section")).toBeNull();
		expect(doc.querySelector(".report-empty")?.textContent).toBe("暂无已登录的套餐。");
	});

	it("查询取消和额度窗口缺失有独立空状态", () => {
		expect(renderToStaticMarkup(createElement(UsageReport, { value: "aborted" }))).toContain("查询已取消");
		const doc = documentOf(createElement(UsageReport, { value: { ...usageReport, providers: [{ id: "anthropic", name: "Claude", status: "ok", plan: undefined, windows: [], details: [], resetCredits: undefined }] } }));
		expect(doc.querySelector("meter")).toBeNull();
		expect(doc.querySelector(".report-section")?.textContent).toContain("暂未提供额度窗口");
	});

	it("遥测使用调用样本计算成功率，耗时按工具展示分位数", () => {
		const doc = documentOf(createElement(TelemetryReport, { value: telemetryReport }));
		expect(doc.querySelector("pre")).toBeNull();
		expect(doc.querySelector(".report-metrics")?.textContent).toContain("66.7%");
		expect(doc.querySelector('[aria-label="read"]')?.getAttribute("value")).toBe("100");
		expect(doc.querySelector('[aria-label="edit"]')?.getAttribute("value")).toBe("50");
		expect(doc.querySelector(".report-tool")?.textContent).toContain("P50");
		expect(doc.querySelector(".report-section")?.textContent).toContain("old_not_found");
		expect(doc.querySelectorAll("details[open]")).toHaveLength(0);
	});

	it("停用且没有调用时不显示虚构的成功率", () => {
		const value = createLiveTelemetryReport({ enabled: false, pending_calls: 0, records: [] });
		const doc = documentOf(createElement(TelemetryReport, { value }));
		expect(doc.querySelector(".report-intro")?.textContent).toContain("采集已停用");
		expect(doc.querySelector(".report-metrics")?.textContent).toContain("暂无数据");
		expect(doc.querySelector("meter")).toBeNull();
	});
});
