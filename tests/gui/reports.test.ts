import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { StatsReport } from "../../src/gui/ui/reports/stats-report.tsx";
import { UsageReport } from "../../src/gui/ui/reports/usage-report.tsx";
import { TelemetryReport } from "../../src/gui/ui/reports/telemetry-report.tsx";
import { createLiveTelemetryReport } from "../../src/harness/telemetry-report/live.ts";
import { statsReport, telemetryReport, usageReport } from "./report-fixtures.ts";

const documentOf = (element: Parameters<typeof renderToStaticMarkup>[0]) => parseHTML(renderToStaticMarkup(element)).document;

describe("报告数据呈现", () => {
	it("会话统计区分上下文占比、缓存命中率和工具输出占比", () => {
		const doc = documentOf(createElement(StatsReport, { value: statsReport }));
		expect(doc.querySelector('[aria-label="上下文占用"]')?.getAttribute("value")).toBe("25");
		expect(doc.querySelector('[aria-label="累计缓存命中率"]')?.getAttribute("value")).toBe("80");
		expect(doc.querySelector('[aria-label="工具输出"]')?.getAttribute("value")).toBe("50");
	});

	it("缺失的上下文用量不伪装为零占用", () => {
		const doc = documentOf(createElement(StatsReport, { value: { ...statsReport, context: { confidence: "estimated", items: [], notes: [] } } }));
		expect(doc.querySelector('[aria-label="上下文占用"]')).toBeNull();
	});

	it("套餐显示剩余额度，区分耗尽、未知窗口、查询失败和未登录", () => {
		const doc = documentOf(createElement(UsageReport, { value: usageReport }));
		expect(doc.querySelector('[aria-label="5 小时"]')?.getAttribute("value")).toBe("65");
		expect(doc.querySelector('[aria-label="Codex"] meter')?.getAttribute("value")).toBe("0");
		expect(doc.querySelector('[aria-label="额外额度"]')).toBeNull();
		expect(doc.querySelector('[aria-label="Kimi"] [role="status"]')).not.toBeNull();
		expect(doc.querySelector('[aria-label="Grok"]')).toBeNull();
		expect(doc.querySelectorAll(".reset-credits li")).toHaveLength(3);
	});

	it("没有已登录套餐时不展示服务商额度", () => {
		const doc = documentOf(createElement(UsageReport, { value: { ...usageReport, providers: [{ id: "xai", name: "Grok", status: "not_logged_in" }] } }));
		expect(doc.querySelector(".report-section")).toBeNull();
		expect(doc.querySelector("meter")).toBeNull();
	});

	it("遥测按调用样本计算成功率，而非平均各工具成功率", () => {
		const doc = documentOf(createElement(TelemetryReport, { value: telemetryReport }));
		expect(doc.querySelector(".report-metrics")?.textContent).toContain("66.7%");
		expect(doc.querySelector('[aria-label="read"]')?.getAttribute("value")).toBe("100");
		expect(doc.querySelector('[aria-label="edit"]')?.getAttribute("value")).toBe("50");
	});

	it("停用且没有调用时不显示虚构的成功率", () => {
		const value = createLiveTelemetryReport({ enabled: false, pending_calls: 0, records: [] });
		const doc = documentOf(createElement(TelemetryReport, { value }));
		expect(doc.querySelector(".report-metrics")?.textContent).not.toContain("%");
		expect(doc.querySelector("meter")).toBeNull();
	});
});
