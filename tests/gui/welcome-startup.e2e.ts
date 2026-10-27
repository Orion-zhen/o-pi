import { test, expect } from "@playwright/test";
import { replayTranscript } from "./transcript-live-fixture.ts";
import { guiModelFixture, guiSnapshot } from "./snapshot-fixture.ts";

const snapshot = () => ({ ...guiSnapshot(), model: guiModelFixture() });
const sessions = (count: number) => Array.from({ length: count }, (_, index) => ({
	path: `/fixture/session-${index}.jsonl`, cwd: "/fixture", title: `历史会话 ${index}`, modified: new Date(index).toISOString(),
}));

test.beforeEach(async ({ page }) => {
	test.skip(await page.evaluate(() => innerWidth < 768), "移动布局不展示桌面侧栏");
	await page.clock.install({ time: 0 });
	await page.clock.pauseAt(1000);
});

test("异步加载历史列表，入场结束后可滚动并打开会话", async ({ page }) => {
	const channel = await replayTranscript(page, snapshot());
	try {
		await page.clock.runFor(600);
		channel.accept({ type: "sessions", value: sessions(200) });
		await page.clock.runFor(600);
		const sidebar = page.getByRole("complementary", { name: "侧栏", exact: true });
		const rows = sidebar.locator(".history-session-row");
		await expect(rows.first()).toBeVisible();
		expect(await rows.count()).toBeLessThan(200);
		const first = await rows.first().innerText();
		await page.clock.resume();
		await sidebar.locator(".history-scroll").hover();
		await page.mouse.wheel(0, 20000);
		await expect(rows.first()).not.toHaveText(first);
		const last = rows.last().getByRole("button", { name: /^历史会话 \d+$/ });
		await expect(last).toBeVisible();
		const sent = page.waitForRequest((request) => request.url().endsWith("/api/action"));
		await last.click();
		expect((await sent).postDataJSON()).toMatchObject({ value: { action: "openSession" } });
	} finally { channel.close(); }
});

test("入场期间输入立即显示晚到的会话，后续列表更新仍可操作", async ({ page }) => {
	const channel = await replayTranscript(page, snapshot());
	try {
		await page.clock.runFor(600);
		channel.accept({ type: "sessions", value: sessions(3) });
		await page.clock.runFor(32);
		const sidebar = page.getByRole("complementary", { name: "侧栏", exact: true });
		const rows = sidebar.locator(".history-session-row");
		await expect(rows).toHaveCount(3);
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.click();
		await editor.fill("先写下想法");
		await page.clock.runFor(32);
		await expect(editor).toHaveValue("先写下想法");
		await expect(rows.first()).toBeVisible();
		await expect(rows.last()).toBeVisible();
		channel.accept({ type: "sessions", value: sessions(4) });
		await page.clock.runFor(32);
		await expect(rows).toHaveCount(4);
		await page.clock.resume();
		const sent = page.waitForRequest((request) => request.url().endsWith("/api/action"));
		await sidebar.getByRole("button", { name: "历史会话 3", exact: true }).click();
		expect((await sent).postDataJSON()).toMatchObject({ value: { action: "openSession", path: "/fixture/session-3.jsonl" } });
	} finally { channel.close(); }
});
