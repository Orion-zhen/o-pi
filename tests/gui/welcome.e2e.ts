import { test, expect, type Page } from "@playwright/test";
import { replayTranscript } from "./transcript-live-fixture.ts";
import { guiModelFixture, guiSnapshot } from "./snapshot-fixture.ts";
import type { GuiSnapshot } from "../../src/gui/shared/protocol/state.ts";

function welcomeSnapshot(): GuiSnapshot {
	const model = guiModelFixture();
	return { ...guiSnapshot(), model, models: [model] };
}

function historySnapshot(): GuiSnapshot {
	return { ...welcomeSnapshot(), leafId: "user-1", contextEntryIds: ["user-1"], entries: [{
		id: "user-1", parentId: null, type: "message", timestamp: new Date(0).toISOString(), label: undefined,
		messages: [{ role: "user", content: "已有会话消息", timestamp: 0 }],
	}] };
}

async function replay(page: Page, snapshot: GuiSnapshot | null) {
	const channel = await replayTranscript(page, snapshot);
	// 协议事件也按帧合并，暂停时钟后需显式推进接收帧。
	await page.clock.runFor(32);
	return channel;
}

async function selectSession(page: Page, channel: Awaited<ReturnType<typeof replayTranscript>>, snapshot: GuiSnapshot) {
	channel.accept({ type: "selected", session: { id: snapshot.sessionId, cwd: snapshot.cwd, path: null } });
	channel.accept({ type: "snapshot", value: snapshot });
	await page.clock.runFor(32);
}

async function ready(page: Page) {
	await expect(page.getByRole("img", { name: "少女捧起 opi 图标" })).toBeVisible();
	await expect(page.locator(".welcome-content")).toHaveCSS("opacity", "1");
	await expect(page.locator(".composer")).toHaveCSS("opacity", "1");
	await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeEditable();
}

test.beforeEach(async ({ page }) => {
	await page.clock.install({ time: 0 });
	await page.clock.pauseAt(1000);
});

test("欢迎页入场后布局完整，切换新会话可直接使用快捷入口", async ({ page }) => {
	const channel = await replay(page, welcomeSnapshot());
	try {
		await page.clock.runFor(1280);
		await ready(page);
		await expect(page.getByRole("img", { name: "少女捧起 opi 图标" })).toBeInViewport({ ratio: 0.5 });
		await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
		await selectSession(page, channel, { ...welcomeSnapshot(), sessionId: "next", name: "新会话" });
		await expect(page.locator(".session-name")).toHaveAccessibleName("新会话");
		await ready(page);
		await page.getByRole("button", { name: "了解项目", exact: true }).click();
		await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("梳理这个项目的结构，介绍主要模块和运行方式。");
	} finally { channel.close(); }
});

test("入场期间可直接输入，收到消息后退出欢迎页", async ({ page }) => {
	const channel = await replay(page, welcomeSnapshot());
	try {
		await page.clock.runFor(200);
		await page.keyboard.press("Tab");
		await page.clock.runFor(32);
		await ready(page);
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("已有会话消息");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		channel.accept({ type: "snapshot", value: historySnapshot() });
		await page.clock.runFor(500);
		await expect(page.getByRole("article").getByText("已有会话消息", { exact: true })).toBeVisible();
		await expect(page.locator(".welcome")).toHaveCount(0);
		await expect(page.locator(".composer")).toHaveCSS("opacity", "1");
		await expect(editor).toBeEditable();
	} finally { channel.close(); }
});

test("恢复历史会话后切换新会话，不重播欢迎入场", async ({ page }) => {
	const channel = await replay(page, historySnapshot());
	try {
		await page.clock.runFor(300);
		await expect(page.getByRole("article").getByText("已有会话消息", { exact: true })).toBeVisible();
		await expect(page.locator(".welcome")).toHaveCount(0);
		await expect(page.locator(".composer")).toHaveCSS("opacity", "1");
		await selectSession(page, channel, { ...welcomeSnapshot(), sessionId: "next", name: "新会话" });
		await expect(page.locator(".session-name")).toHaveAccessibleName("新会话");
		await ready(page);
	} finally { channel.close(); }
});

test("尚无会话时显示工作区选择，交互后的首个会话直接可用", async ({ page }) => {
	const channel = await replay(page, null);
	try {
		await page.clock.runFor(600);
		await expect(page.getByRole("heading", { name: "选择工作区", exact: true })).toBeVisible();
		await page.keyboard.press("Tab");
		await page.clock.runFor(32);
		await expect(page.locator(".welcome-content")).toHaveCSS("opacity", "1");
		await selectSession(page, channel, welcomeSnapshot());
		await page.clock.runFor(300);
		await expect(page.locator(".session-name")).toHaveAccessibleName("测试会话");
		await ready(page);
	} finally { channel.close(); }
});

test("会话信息随会话切换更新，并可收起和展开", async ({ page }) => {
	const channel = await replay(page, welcomeSnapshot());
	try {
		await page.clock.runFor(1280);
		const sidebar = page.getByRole("complementary", { name: "会话信息", exact: true });
		await expect(sidebar.getByRole("tab", { name: "会话树", exact: true })).toBeVisible();
		await selectSession(page, channel, { ...historySnapshot(), sessionId: "next", name: "历史会话" });
		await expect(page.locator(".session-name")).toHaveAccessibleName("历史会话");
		await expect(sidebar.getByText("已有会话消息", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "收起会话信息", exact: true }).click();
		await expect(sidebar).toHaveCount(0);
		await page.getByRole("button", { name: "展开会话信息", exact: true }).click();
		await expect(sidebar.getByText("已有会话消息", { exact: true })).toBeVisible();
	} finally { channel.close(); }
});
