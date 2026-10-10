import { test, expect } from "@playwright/test";
import type { GuiEntry, GuiMessage } from "../../src/gui/messages.ts";
import { liveSnapshot, replayTranscript } from "./transcript-live-fixture.ts";
import { assistant } from "./transcript-fixtures.ts";

function scrollSnapshot(turns: number) {
	const entries: GuiEntry[] = [];
	const append = (message: GuiMessage) => entries.push({
		id: `entry-${entries.length}`, parentId: entries.at(-1)?.id ?? null,
		type: "message", timestamp: new Date(message.timestamp).toISOString(), messages: [message], label: undefined,
	});
	for (let index = 0; index < turns; index++) {
		append({ role: "user", content: `问题-${index}`, timestamp: index * 2 + 1 });
		append({ ...assistant([{ type: "text", text: `回复-${index}\n\n` + "检查状态与组件边界。\n\n".repeat(4) }], "stop"), timestamp: index * 2 + 2 });
	}
	append({ role: "user", content: "继续输出", timestamp: turns * 2 + 1 });
	return { ...liveSnapshot(), entries, contextEntryIds: entries.map((entry) => entry.id), leafId: entries.at(-1)?.id ?? null,
		streamingMessage: { ...assistant([{ type: "text", text: "新内容" }], "pending"), timestamp: turns * 2 + 2 } };
}

test("中断返回最新后保留位置，恢复后跟随流式内容", async ({ page }) => {
	const snapshot = scrollSnapshot(20);
	const channel = await replayTranscript(page, snapshot);
	try {
		const reader = page.locator(".transcript");
		const latest = page.getByRole("button", { name: "回到最新", exact: true });
		const distance = () => reader.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
		await expect(reader.locator(".reply-answer").last()).toContainText("新内容");
		await reader.evaluate((element) => { element.scrollTop = 0; });
		await expect(latest).toBeVisible();
		await latest.click();
		await expect.poll(() => reader.evaluate((element) => element.scrollTop), { intervals: [10] }).toBeGreaterThan(20);
		await reader.dispatchEvent("pointerdown");
		await page.waitForTimeout(200);
		const stopped = await reader.evaluate((element) => element.scrollTop);
		expect(await distance()).toBeGreaterThan(200);
		await page.waitForTimeout(500);
		expect(await reader.evaluate((element) => element.scrollTop)).toBeCloseTo(stopped, 0);
		channel.accept({ type: "stream", sessionId: snapshot.sessionId,
			value: { ...snapshot.streamingMessage, content: [{ type: "text", text: "暂停期间追加。\n\n".repeat(30) }] } });
		await expect(latest).toBeVisible();
		await page.waitForTimeout(200);
		expect(await reader.evaluate((element) => element.scrollTop)).toBeCloseTo(stopped, 0);
		await latest.click();
		await expect.poll(distance).toBeLessThan(3);
		channel.accept({ type: "stream", sessionId: snapshot.sessionId,
			value: { ...snapshot.streamingMessage, content: [{ type: "text", text: "恢复后追加。\n\n".repeat(60) }] } });
		await expect(reader.locator(".reply-answer").last()).toContainText("恢复后追加");
		await expect.poll(distance).toBeLessThan(3);
	} finally { channel.close(); }
});

test("追加新轮次时保持置底，展开过程后暂停跟随", async ({ page }) => {
	const turns = 20;
	const snapshot = scrollSnapshot(turns);
	const channel = await replayTranscript(page, snapshot);
	try {
		const reader = page.locator(".transcript");
		const distance = () => reader.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
		await expect(reader.locator(".reply-answer").last()).toContainText("新内容");
		await reader.evaluate((element) => { element.scrollTop = 0; });
		await page.getByRole("button", { name: "回到最新", exact: true }).click();
		await expect.poll(distance).toBeLessThan(3);
		const entries = [...snapshot.entries];
		for (const message of [
			{ ...snapshot.streamingMessage, stopReason: "stop" },
			{ role: "user", content: "追加一轮", timestamp: turns * 2 + 3 },
		] satisfies GuiMessage[]) entries.push({
			id: `entry-${entries.length}`, parentId: entries.at(-1)?.id ?? null,
			type: "message", timestamp: new Date(message.timestamp).toISOString(), messages: [message], label: undefined,
		});
		const streamingMessage = { ...assistant([
			{ type: "thinking", thinking: "检查滚动状态" }, { type: "text", text: "追加的新轮次" },
		], "pending"), timestamp: turns * 2 + 4 };
		channel.accept({ type: "snapshot", value: { ...snapshot, entries, leafId: entries.at(-1)?.id ?? null,
			contextEntryIds: entries.map((entry) => entry.id), streamingMessage } });
		await expect(reader.locator(".reply-answer").last()).toContainText("追加的新轮次");
		await expect.poll(distance).toBeLessThan(3);
		const process = reader.locator(".assistant-reply").last().locator(".reply-process");
		await process.locator(":scope > .disclosure-trigger").click();
		await expect(process).toHaveAttribute("data-state", "open");
		await page.waitForTimeout(350);
		const top = await reader.evaluate((element) => element.scrollTop);
		channel.accept({ type: "stream", sessionId: snapshot.sessionId,
			value: { ...streamingMessage, content: [
				{ type: "thinking", thinking: "检查滚动状态" }, { type: "text", text: "暂停后增长。\n\n".repeat(30) },
			] } });
		await expect(reader.locator(".reply-answer").last()).toContainText("暂停后增长");
		await page.waitForTimeout(200);
		expect(await reader.evaluate((element) => element.scrollTop)).toBeCloseTo(top, 0);
		expect(await distance()).toBeGreaterThan(200);
	} finally { channel.close(); }
});

test("命令输出和视口变化仍保持置底", async ({ page }) => {
	const snapshot = scrollSnapshot(20);
	const channel = await replayTranscript(page, snapshot);
	try {
		const reader = page.locator(".transcript");
		const distance = () => reader.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
		await expect(reader.locator(".reply-answer").last()).toContainText("新内容");
		await reader.evaluate((element) => { element.scrollTop = 0; });
		await page.getByRole("button", { name: "回到最新", exact: true }).click();
		await expect.poll(distance).toBeLessThan(3);
		for (const lines of [5, 50]) {
			channel.accept({ type: "snapshot", value: { ...snapshot, bashOutput: "命令输出\n".repeat(lines) } });
			await expect(reader.locator(".live-output")).toContainText("命令输出");
			await expect.poll(distance).toBeLessThan(3);
		}
		const viewport = page.viewportSize();
		if (!viewport) throw new Error("缺少视口尺寸");
		await page.setViewportSize({ ...viewport, height: viewport.height - 100 });
		await expect.poll(distance).toBeLessThan(3);
	} finally { channel.close(); }
});

test("切换会话后恢复阅读位置", async ({ page }) => {
	const first = { ...scrollSnapshot(20), name: "历史会话" };
	const second = { ...scrollSnapshot(5), sessionId: "other-session", name: "另一会话" };
	const channel = await replayTranscript(page, first);
	try {
		const reader = page.locator(".transcript");
		await expect(reader.locator(".reply-answer").last()).toContainText("新内容");
		await reader.dispatchEvent("pointerdown");
		await reader.evaluate((element) => { element.scrollTop = element.scrollHeight - element.clientHeight - 900; });
		await expect(page.getByRole("button", { name: "回到最新", exact: true })).toBeVisible();
		await page.waitForTimeout(200);
		const top = await reader.evaluate((element) => element.scrollTop);
		channel.accept({ type: "selected", session: { id: second.sessionId, cwd: second.cwd, path: null } });
		channel.accept({ type: "snapshot", value: second });
		await expect(page.locator(".session-heading")).toContainText(second.name);
		channel.accept({ type: "selected", session: { id: first.sessionId, cwd: first.cwd, path: null } });
		channel.accept({ type: "snapshot", value: first });
		await expect(page.locator(".session-heading")).toContainText(first.name);
		await expect.poll(async () => Math.abs(await reader.evaluate((element) => element.scrollTop) - top)).toBeLessThan(3);
	} finally { channel.close(); }
});
