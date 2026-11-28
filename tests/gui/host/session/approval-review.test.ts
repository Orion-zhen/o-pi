import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReviewOpinion } from "../../../../src/harness/approval/runtime/ai-review.ts";
import { GuiDialogs } from "../../../../src/gui/host/session/dialogs.ts";
import type { SingleTargetRequest } from "../../../../src/harness/approval/types.ts";

const request: SingleTargetRequest = { cwd: "/workspace", tool: "write", unit: { action: "write_file", remember: true, target: { kind: "path", value: "/workspace/file" } }, detail: { path: "/workspace/file", content: "content" } };
function open(timeout?: number, delay = 1000) {
	const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set() {} });
	const result = Promise.withResolvers<ReviewOpinion>();
	const run = vi.fn((_signal: AbortSignal) => result.promise);
	const pending = dialogs.approve(request, { kind: "ask", reason: "write", items: [{ unit: request.unit, reason: "write" }] },
		["Allow once", "Deny", "Deny with instruction"], { ...(timeout && { timeout }), review: { delay, run } });
	const [dialog] = dialogs.list();
	if (!dialog) throw new Error("missing approval");
	return { dialogs, result, pending, id: dialog.id, signal: run.mock.calls[0]?.[0] };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each(["allow", "deny"] as const)("及时收到 %s 后给足新的等待时间", async decision => {
	const { dialogs, result, pending } = open(3000);
	await vi.advanceTimersByTimeAsync(2900);
	result.resolve({ decision, reason: "依据" });
	await vi.advanceTimersByTimeAsync(999);
	expect(dialogs.list()[0]).toMatchObject({ stage: { kind: "choose", review: { kind: "ready", decision } }, deadline: null });
	await vi.advanceTimersByTimeAsync(1);
	await expect(pending).resolves.toEqual(decision === "allow" ? { kind: "approved" } : { kind: "ai-denied", reason: "依据" });
	expect(dialogs.list()).toEqual([]);
});
it("仅展示建议时不限时等待，手动选择可以与建议不同", async () => {
	const { dialogs, result, pending, id } = open(undefined, 0);
	result.resolve({ decision: "deny", reason: "未经授权" });
	await vi.advanceTimersByTimeAsync(60000);
	expect(dialogs.list()[0]).toMatchObject({ deadline: null, stage: { review: { kind: "ready", decision: "deny", reason: "未经授权", end: null } } });
	dialogs.respond({ id, value: "Allow once" });
	await expect(pending).resolves.toEqual({ kind: "approved" });
});
it("仅展示建议时保留弹窗期限，到期拒绝而非采纳 allow", async () => {
	const { dialogs, result, pending } = open(200, 0);
	const deadline = dialogs.list()[0]?.deadline;
	result.resolve({ decision: "allow", reason: "已授权" });
	await vi.advanceTimersByTimeAsync(199);
	expect(dialogs.list()[0]).toMatchObject({ deadline, stage: { review: { kind: "ready", decision: "allow", end: null } } });
	await vi.advanceTimersByTimeAsync(1);
	await expect(pending).resolves.toEqual({ kind: "denied" });
});
it("原超时取消请求，迟到的 allow 不得生效", async () => {
	const { dialogs, result, pending, signal } = open(100);
	await vi.advanceTimersByTimeAsync(100);
	expect(signal?.aborted).toBe(true);
	result.resolve({ decision: "allow", reason: "late" });
	await vi.advanceTimersByTimeAsync(1000);
	await expect(pending).resolves.toEqual({ kind: "denied" });
	expect(dialogs.list()).toEqual([]);
});
it("评审失败保留原截止时间", async () => {
	const { dialogs, result, pending } = open(200);
	const deadline = dialogs.list()[0]?.deadline;
	await vi.advanceTimersByTimeAsync(75);
	result.reject(new Error("model unavailable"));
	await vi.advanceTimersByTimeAsync(0);
	expect(dialogs.list()[0]).toMatchObject({ stage: { kind: "choose", review: { kind: "unavailable" } }, deadline });
	await vi.advanceTimersByTimeAsync(125);
	await expect(pending).resolves.toEqual({ kind: "denied" });
});
it.each([true, false])("拒绝并说明立即取消 AI，请求已返回：%s", async ready => {
	const { dialogs, result, id, pending, signal } = open();
	const opinion = { decision: "allow", reason: "yes" } as const;
	if (ready) { result.resolve(opinion); await vi.advanceTimersByTimeAsync(0); }
	dialogs.respond({ id, value: "Deny with instruction" });
	expect(signal?.aborted).toBe(true);
	result.resolve(opinion);
	await vi.advanceTimersByTimeAsync(1100);
	const [dialog] = dialogs.list();
	if (dialog?.kind !== "toolApproval" || dialog.stage.kind !== "instruction") throw new Error("missing instruction");
	dialogs.respond({ id, token: dialog.stage.token, value: "预览即可" });
	await expect(pending).resolves.toEqual({ kind: "denied", instruction: "预览即可" });
});
