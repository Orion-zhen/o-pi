import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { StatsReport } from "../../src/gui/frontend/features/reports/stats-report.tsx";
import { UsageReport } from "../../src/gui/frontend/features/reports/usage-report.tsx";
import { TooltipProvider } from "../../src/gui/frontend/ui/tooltip.tsx";
import { TelemetryReport } from "../../src/gui/frontend/features/reports/telemetry-report.tsx";
import { createLiveTelemetryReport } from "../../src/harness/telemetry-report/live.ts";
import { statsReport, telemetryReport, usageReport } from "./report-fixtures.ts";

const usageActions = {
	disabled: false,
	onRefresh: async () => {},
	onUse: async () => ({ outcome: "reset" as const, refreshed: true }),
};
const documentOf = (element: Parameters<typeof renderToStaticMarkup>[0]) => parseHTML(renderToStaticMarkup(createElement(TooltipProvider, null, element))).document;

describe("报告数据呈现", () => {
	it("会话统计区分上下文占比、缓存命中率和工具输出占比", () => {
		const doc = documentOf(createElement(StatsReport, { value: statsReport }));
		expect(doc.querySelector('[aria-label="上下文占用"]')?.getAttribute("value")).toBe("25");
		expect(doc.querySelector('[aria-label="对话累计缓存命中率"]')?.getAttribute("value")).toBe("80");
		expect(doc.querySelector('[aria-label="工具输出"]')?.getAttribute("value")).toBe("50");
	});

	it("缺失的上下文用量不伪装为零占用", () => {
		const doc = documentOf(createElement(StatsReport, { value: { ...statsReport, context: { confidence: "estimated", items: [], notes: [] } } }));
		expect(doc.querySelector('[aria-label="上下文占用"]')).toBeNull();
	});

	it("套餐显示剩余额度，区分耗尽、未知窗口和查询失败", () => {
		const doc = documentOf(createElement(UsageReport, { ...usageActions, value: usageReport }));
		expect(doc.querySelector('[aria-label="5 小时"]')?.getAttribute("value")).toBe("65");
		expect(doc.querySelector('[aria-label="Codex"] meter')?.getAttribute("value")).toBe("0");
		expect(doc.querySelector('[aria-label="额外额度"]')).toBeNull();
		expect(doc.querySelector('[aria-label="Kimi"] [role="status"]')).not.toBeNull();
		expect(doc.querySelectorAll(".reset-credits li")).toHaveLength(3);
	});

	it("重置卡缺少 ID 时只展示，已过期或已消费时禁用按钮", () => {
		const value = { ...usageReport, providers: usageReport.providers.map((provider) => provider.id === "openai-codex" && provider.status === "ok" && provider.kind === "plan" ? {
			...provider, resetCredits: { availableCount: 1, credits: [
				{ id: "available", status: "available", grantedAt: "2025-12-01T00:00:00Z", expiresAt: undefined },
				{ id: undefined, status: "available", grantedAt: "2025-12-01T00:00:00Z", expiresAt: undefined },
				{ id: "expired", status: "available", grantedAt: "2025-12-01T00:00:00Z", expiresAt: "2026-01-01T00:00:00Z" },
				{ id: "consumed", status: "consumed", grantedAt: "2025-12-01T00:00:00Z", expiresAt: undefined },
			] },
		} : provider) };
		const doc = documentOf(createElement(UsageReport, { ...usageActions, value }));
		const buttons = Array.from(doc.querySelectorAll(".reset-credit-use"));
		expect(buttons).toHaveLength(3);
		expect(buttons.every((button) => !button.hasAttribute("title"))).toBe(true);
		expect(buttons.map((button) => button.hasAttribute("disabled"))).toEqual([false, true, true]);
	});

	it("DeepSeek 显示连接状态、原始余额和分项，不显示套餐进度", () => {
		const doc = documentOf(createElement(UsageReport, { ...usageActions, value: usageReport }));
		const card = doc.querySelector('[aria-label="DeepSeek"]');
		expect(card?.querySelector("h3")?.textContent).toBe("DeepSeek");
		expect(card?.querySelector('[data-tone="success"]')?.textContent).toBe("已连接");
		expect(card?.textContent).toContain("API 余额");
		expect(Array.from(card?.querySelectorAll("dt") ?? [], (label) => [label.textContent, label.nextElementSibling?.textContent])).toEqual([
			["可用余额", "CNY 12.3456"],
			["充值余额", "CNY 10.0000"],
			["赠金余额", "CNY 2.3456"],
		]);
		expect(card?.querySelector("meter")).toBeNull();
		expect(card?.textContent).not.toMatch(/套餐名称未提供|额度窗口/);
	});

	it("按返回币种显示多份余额，余额不足保留已连接状态", () => {
		const doc = documentOf(createElement(UsageReport, { ...usageActions, value: { ...usageReport, providers: [{
			id: "deepseek", name: "DeepSeek", status: "ok", kind: "balance", isAvailable: false, balances: [
				{ currency: "CNY", total: "0.00", granted: "0.00", toppedUp: "0.00" },
				{ currency: "USD", total: "-0.00001", granted: "0", toppedUp: "-0.00001" },
			],
		}] } }));
		expect(Array.from(doc.querySelectorAll(".report-metric dd"), (element) => element.textContent)).toEqual(["CNY 0.00", "USD -0.00001"]);
		expect(doc.querySelector('.report-badge[data-tone="success"]')?.textContent).toBe("已连接");
		expect(doc.querySelector('[role="status"]')?.textContent).toBe("余额不足，暂不可调用 API。");
	});

	it("没有配置服务商时显示空状态", () => {
		const doc = documentOf(createElement(UsageReport, { ...usageActions, value: { ...usageReport, providers: [] } }));
		expect(doc.querySelector(".report-empty")?.textContent).toBe("暂无已配置的套餐或 API 余额服务。");
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
