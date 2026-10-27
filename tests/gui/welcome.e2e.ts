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

async function characterPose(page: Page) {
	return page.locator(".welcome-illustration").evaluate((svg) => {
		const paths = (layer: string) => [...svg.querySelectorAll(`[data-layer="${layer}"] path`)].map((path) => path.getAttribute("d")).join("");
		return { hair: paths("hair"), face: paths("face-neck"), sleeve: paths("right-sleeve"), hand: paths("right-hand") };
	});
}

async function idleStart(page: Page, random: number) {
	await page.clock.runFor(1280);
	await ready(page);
	await page.evaluate((value) => { Math.random = () => value; }, random);
	await page.keyboard.press("Shift");
	await page.clock.runFor(32);
	return characterPose(page);
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

test("待机随机播放吹风或捧起，不叠加且允许连续选择相同动作", async ({ page }) => {
	const channel = await replay(page, welcomeSnapshot());
	try {
		const base = await idleStart(page, 0.1);
		await page.clock.runFor(4800);
		expect(await characterPose(page)).toEqual(base);
		await page.clock.runFor(1400);
		const wind = await characterPose(page);
		expect(wind.hair === base.hair).toBe(false);
		expect(wind.sleeve === base.sleeve).toBe(false);
		expect(wind.face === base.face).toBe(true);
		expect(wind.hand === base.hand).toBe(true);
		await expect(page.locator('.welcome-illustration [data-layer="right-sleeve"]')).toBeInViewport({ ratio: 1 });
		expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
		await page.clock.runFor(500);
		expect((await characterPose(page)).hair === wind.hair).toBe(false);
		await page.clock.runFor(4500);
		expect(await characterPose(page)).toEqual(base);

		await page.evaluate(() => { Math.random = () => 0.9; });
		await page.clock.runFor(13000);
		const offer = await characterPose(page);
		expect(offer.face === base.face).toBe(false);
		expect(offer.hand === base.hand).toBe(false);
		await page.clock.runFor(4000);
		expect(await characterPose(page)).toEqual(base);
		await page.clock.runFor(14000);
		const repeated = await characterPose(page);
		expect(repeated.face === base.face).toBe(false);
		expect(repeated.hand === base.hand).toBe(false);
	} finally { channel.close(); }
});

for (const [name, random] of [["吹风", 0.1], ["捧起", 0.9]] as const) {
	test(`输入打断${name}后归位，重新空闲才播放下一次`, async ({ page }) => {
		const channel = await replay(page, welcomeSnapshot());
		try {
			const base = await idleStart(page, random);
			await page.clock.runFor(6200);
			expect((await characterPose(page)).hair === base.hair).toBe(false);
			await page.getByRole("textbox", { name: "消息", exact: true }).fill("先写下想法");
			await page.clock.runFor(500);
			expect(await characterPose(page)).toEqual(base);
			await page.clock.runFor(4300);
			expect(await characterPose(page)).toEqual(base);
			await page.clock.runFor(1400);
			expect((await characterPose(page)).hair === base.hair).toBe(false);
		} finally { channel.close(); }
	});
}

for (const [name, random] of [["吹风", 0.1], ["捧起", 0.9]] as const) {
	test(`失焦时仍按原节奏触发${name}，焦点切换不打断播放`, async ({ page }) => {
		const channel = await replay(page, welcomeSnapshot());
		try {
			const base = await idleStart(page, random);
			await page.clock.runFor(3000);
			await page.evaluate(() => {
				Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
				window.dispatchEvent(new Event("blur"));
			});
			await page.clock.runFor(1800);
			expect(await characterPose(page)).toEqual(base);
			await page.clock.runFor(1400);
			const active = await characterPose(page);
			expect(active.hair === base.hair).toBe(false);
			await page.evaluate(() => {
				Reflect.deleteProperty(document, "hasFocus");
				window.dispatchEvent(new Event("focus"));
			});
			await page.clock.runFor(300);
			expect((await characterPose(page)).hair === base.hair).toBe(false);
			await page.evaluate(() => {
				Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
				window.dispatchEvent(new Event("blur"));
			});
			await page.clock.runFor(300);
			const continued = await characterPose(page);
			expect(continued.hair === base.hair).toBe(false);
			expect(continued.hair === active.hair).toBe(false);
			await page.clock.runFor(5000);
			expect(await characterPose(page)).toEqual(base);
			await page.clock.runFor(13000);
			expect((await characterPose(page)).hair === base.hair).toBe(false);
		} finally { channel.close(); }
	});
}

test("页面隐藏时停止待机，恢复后重新等待", async ({ page }) => {
	const channel = await replay(page, welcomeSnapshot());
	try {
		const base = await idleStart(page, 0.1);
		await page.clock.runFor(6200);
		await page.evaluate(() => {
			Object.defineProperty(document, "hidden", { configurable: true, value: true });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await page.clock.runFor(6400);
		expect(await characterPose(page)).toEqual(base);
		await page.evaluate(() => {
			Reflect.deleteProperty(document, "hidden");
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await page.clock.runFor(4800);
		expect(await characterPose(page)).toEqual(base);
		await page.clock.runFor(1400);
		expect((await characterPose(page)).hair === base.hair).toBe(false);
	} finally { channel.close(); }
});
