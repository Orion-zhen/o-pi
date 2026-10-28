import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { GuiUsageResetResult } from "../../../../../src/gui/shared/protocol/actions.ts";
import { UsageReport } from "../../../../../src/gui/frontend/features/reports/usage-report.tsx";
import { TooltipProvider } from "../../../../../src/gui/frontend/ui/tooltip.tsx";
import { useReactFixture } from "../../../helpers/react-fixture.ts";
import { usageReport } from "./report-fixtures.ts";

const render = useReactFixture();
const onRefresh = async () => {};
beforeEach(() => {
	vi.stubGlobal("getComputedStyle", (element: HTMLElement) => element.style);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
	vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});
function button(selector = ".reset-credit-use"): HTMLButtonElement {
	const element = document.querySelector<HTMLButtonElement>(selector);
	if (!element) throw new Error(`缺少按钮: ${selector}`);
	return element;
}
async function useCredit() {
	await act(async () => button().click());
	await act(async () => button().click());
}

it.each([
	["reset", "重置卡已使用"], ["nothing_to_reset", "未消耗重置卡"],
	["no_credit", "这张重置卡已不可用"], ["already_redeemed", "无需重复消耗重置卡"],
] as const)("展示明确兑换结果 %s", async (outcome, message) => {
	const consume = vi.fn(async (): Promise<GuiUsageResetResult> => ({ outcome, refreshed: true }));
	await render(<TooltipProvider><UsageReport value={usageReport} onUse={consume} onRefresh={onRefresh} disabled={false} /></TooltipProvider>);
	await useCredit();
	expect(document.body.textContent).toContain(message);
	expect(consume).toHaveBeenCalledOnce();
});

it("兑换明确但刷新失败时保留结果和卡片，重试不沿用旧请求 ID", async () => {
	const consume = vi.fn(async (_creditId: string, _requestId: string): Promise<GuiUsageResetResult> => ({ outcome: "nothing_to_reset", refreshed: false }));
	await render(<TooltipProvider><UsageReport value={usageReport} onUse={consume} onRefresh={onRefresh} disabled={false} /></TooltipProvider>);
	await useCredit();
	expect(document.body.textContent).toContain("当前没有需要重置的额度，未消耗重置卡。");
	expect(document.body.textContent).toContain("用量刷新失败，请刷新后查看最新额度。");
	expect(document.body.textContent).not.toContain("未能确认");
	expect(document.querySelectorAll(".reset-credit-use")).toHaveLength(3);
	await useCredit();
	expect(consume).toHaveBeenCalledTimes(2);
	expect(consume.mock.calls[1]?.[1]).not.toBe(consume.mock.calls[0]?.[1]);
});

it.each(["取消", "失败"] as const)("查询%s后恢复，结果不明的兑换仍沿用原请求 ID", async (failure) => {
	const consume = vi.fn(async (_creditId: string, _requestId: string): Promise<GuiUsageResetResult> => { throw new Error("未能确认重置结果"); });
	const report = (value: typeof usageReport | "aborted") => <TooltipProvider><UsageReport value={value} onUse={consume} onRefresh={onRefresh} disabled={false} /></TooltipProvider>;
	await render(report(usageReport));
	await useCredit();
	expect(document.body.textContent).toContain("未能确认重置结果");
	expect(consume).toHaveBeenCalledOnce();
	await render(report(failure === "取消" ? "aborted" : {
		...usageReport, providers: usageReport.providers.map((provider) => provider.id === "openai-codex"
			? { id: provider.id, name: provider.name, status: "error", error: { code: "timeout" } } : provider),
	}));
	expect(document.querySelector(".reset-credit-use")).toBeNull();
	await render(report(usageReport));
	consume.mockResolvedValueOnce({ outcome: "already_redeemed", refreshed: true });
	await useCredit();
	expect(consume).toHaveBeenCalledTimes(2);
	expect(consume.mock.calls[1]).toEqual(consume.mock.calls[0]);
	expect(document.body.textContent).toContain("无需重复消耗重置卡");
});

it("刷新期间禁用兑换和重复刷新，完成后恢复", async () => {
	const result = Promise.withResolvers<void>();
	const refresh = vi.fn(async () => result.promise);
	const consume = vi.fn(async (): Promise<GuiUsageResetResult> => ({ outcome: "reset", refreshed: true }));
	await render(<TooltipProvider><UsageReport value={usageReport} onUse={consume} onRefresh={refresh} disabled={false} /></TooltipProvider>);
	await act(async () => button(".usage-report-footer button").click());
	for (const element of document.querySelectorAll<HTMLButtonElement>("button")) {
		expect(element.disabled).toBe(true);
		await act(async () => element.click());
	}
	expect(refresh).toHaveBeenCalledOnce();
	expect(consume).not.toHaveBeenCalled();
	await act(async () => result.resolve());
	expect(button().disabled).toBe(false);
	expect(button(".usage-report-footer button").disabled).toBe(false);
});

it("兑换和刷新共用执行状态，失败提示不覆盖为泛化错误", async () => {
	const result = Promise.withResolvers<GuiUsageResetResult>();
	const consume = vi.fn(async () => result.promise);
	const refresh = vi.fn(async () => {});
	await render(<TooltipProvider><UsageReport value={usageReport} onUse={consume} onRefresh={refresh} disabled={false} /></TooltipProvider>);
	await useCredit();
	for (const element of document.querySelectorAll<HTMLButtonElement>("button")) {
		expect(element.disabled).toBe(true);
		await act(async () => element.click());
	}
	expect(consume).toHaveBeenCalledOnce();
	expect(refresh).not.toHaveBeenCalled();
	await act(async () => { result.reject(new Error("Codex 认证失败，请重新登录。")); });
	expect(document.body.textContent).toContain("Codex 认证失败，请重新登录。");
	expect(document.body.textContent).not.toContain("未能确认");
	expect(button().disabled).toBe(false);
	expect(refresh).not.toHaveBeenCalled();
	await act(async () => button(".usage-report-footer button").click());
	expect(refresh).toHaveBeenCalledOnce();
	expect(document.body.textContent).not.toContain("Codex 认证失败");
});
