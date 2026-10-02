import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixture.ts";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;

async function sdkVersions() {
	const text = await readFile(path.resolve("node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md"), "utf8");
	const [current, previous] = [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((match) => match[1]);
	if (!current || !previous) throw new Error("SDK 更新日志缺少版本条目。");
	return { current, previous };
}

for (const mode of ["web", "desktop"] as const) test.describe(mode, () => {
	test.use({ mode });
	test.beforeEach(({}, info) => { test.skip(mode === "desktop" && info.project.name !== "desktop", "桌面应用使用桌面窗口"); });

	for (const collapsed of [false, true]) test(`启动日志内联展示、折叠和已读持久化 (${collapsed})`, async ({ gui: { page }, workspace: { agentDir } }, info) => {
		const file = path.join(agentDir, "settings.json");
		const stored = async (): Promise<Settings> => JSON.parse(await readFile(file, "utf8"));
		const { current, previous } = await sdkVersions();
		const notice = page.getByRole("region", { name: "Pi 更新日志" });
		// 首次使用只记录版本，再模拟下一次启动前 SDK 升级。
		await expect.poll(async () => (await stored()).lastChangelogVersion).toBe(current);
		await expect(notice).toHaveCount(0);
		await writeFile(file, JSON.stringify({ ...await stored(), lastChangelogVersion: previous, collapseChangelog: collapsed, quietStartup: true }));
		let disconnect: (() => Promise<void>) | undefined;
		if (mode === "web") await page.routeWebSocket("**/api/events*", (socket) => {
			const server = socket.connectToServer();
			disconnect = async () => { await Promise.all([socket.close(), server.close()]); };
		});
		await page.reload();
		await expect(notice).toBeVisible();
		const toggle = notice.getByRole("button");
		await expect(toggle).toHaveAttribute("aria-expanded", String(!collapsed));
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect.poll(async () => (await stored()).lastChangelogVersion).toBe(current);
		expect(await notice.evaluate((node) => node.contains(document.activeElement))).toBe(false);
		expect(await page.locator(".transcript").evaluate((node) => node.scrollTop)).toBeLessThan(2);

		await toggle.focus();
		await toggle.press("Enter");
		await expect(toggle).toHaveAttribute("aria-expanded", String(collapsed));
		if (!collapsed) await toggle.press("Enter");
		await expect(notice.getByRole("heading", { name: new RegExp(current.replaceAll(".", "\\.")) }).first()).toBeVisible();
		await expect(notice.getByRole("link").first()).toHaveAttribute("href", new RegExp(`/v${current.replaceAll(".", "\\.")}/packages/coding-agent/`));

		if (!collapsed) {
			for (const colorScheme of ["light", "dark"] as const) {
				await page.emulateMedia({ colorScheme });
				await page.screenshot({ path: info.outputPath(`changelog-${colorScheme}.png`), animations: "disabled" });
			}
			await page.getByRole("button", { name: "收起会话信息", exact: true }).click();
			for (const { width, height, font } of [{ width: 390, height: 844, font: "100%" }, { width: 1000, height: 450, font: "100%" }, { width: 1200, height: 1000, font: "200%" }]) {
				await page.setViewportSize({ width, height });
				await page.evaluate((font) => { document.documentElement.style.fontSize = font; }, font);
				await expect.poll(() => notice.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
				await toggle.focus();
				await toggle.press("Enter");
				await expect(toggle).toHaveAttribute("aria-expanded", "false");
				await expect(toggle).toBeInViewport();
				await page.screenshot({ path: info.outputPath(`changelog-${font}-${width}.png`), animations: "disabled" });
				await toggle.press("Enter");
			}
			await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
			await page.setViewportSize(info.project.use.viewport ?? { width: 1200, height: 820 });
		}

		if (mode === "web") {
			if (!disconnect) throw new Error("缺少 WebSocket 连接。");
			await disconnect();
			await expect(page.getByRole("button", { name: "重新连接", exact: true })).toBeVisible();
			await expect(page.getByRole("button", { name: "重新连接", exact: true })).toHaveCount(0);
			await expect(notice).toHaveCount(1);
		}
		const id = await page.evaluate(() => sessionStorage.getItem("opi.session"));
		if ((page.viewportSize()?.width ?? 1200) < 768) await page.getByRole("button", { name: "菜单", exact: true }).click();
		await page.getByRole("button", { name: "新建会话", exact: true }).click();
		await page.waitForFunction((previous) => sessionStorage.getItem("opi.session") !== previous, id);
		await expect(notice).toHaveCount(0);
		await page.reload();
		await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
		await expect(notice).toHaveCount(0);
	});
});
