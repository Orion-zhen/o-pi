import { test, expect, _electron as electron } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

// 真实展示组件使用边界数据，避免测试依赖个人 OAuth 账号和外部套餐服务。
test("统计报告：额度、状态和响应式可视化", async ({ viewport }, info) => {
	const app = await electron.launch({ args: [path.resolve("tests/gui/web-browser.cjs"), "--no-sandbox"] });
	try {
		const page = await app.firstWindow();
		if (viewport) await page.setViewportSize(viewport);
		const assets = path.resolve("dist/gui/assets");
		const css = (await Promise.all((await readdir(assets)).filter((file) => file.endsWith(".css")).map((file) => readFile(path.join(assets, file), "utf8")))).join("\n");
		const reports = JSON.parse(execFileSync("bun", ["tests/gui/report-markup.ts"], { encoding: "utf8" })) as { name: string; html: string }[];
		for (const { name, html } of reports) {
			await page.setContent(html);
			await page.addStyleTag({ content: css });
			await expect(page.locator(".report-dashboard")).toBeVisible();
			await expect(page.locator("pre")).toHaveCount(0);
			if (name === "usage") {
				await expect(page.locator(".report-intro")).toHaveCount(0);
				await expect(page.getByRole("heading", { name: "Grok", exact: true })).toHaveCount(0);
				await expect(page.getByRole("meter", { name: "5 小时", exact: true })).toHaveAttribute("value", "65");
				await expect(page.getByText("剩余 0%", { exact: true })).toBeVisible();
				await expect(page.getByText("用量暂不可用", { exact: true })).toBeVisible();
				await expect(page.getByRole("status")).toContainText("查询超时");
				await expect(page.getByText("已使用", { exact: true })).toHaveCount(0);
				await expect(page.getByText("计量周期", { exact: true })).toHaveCount(0);
				await expect(page.locator(".usage-reset")).toHaveCount(4);
				expect(await page.locator(".usage-reset dd").evaluateAll((items) => items.every((item) => {
					const style = getComputedStyle(item);
					return Number.parseFloat(style.fontSize) > Number.parseFloat(getComputedStyle(document.documentElement).fontSize) && Number.parseFloat(style.fontWeight) >= 600;
				}))).toBe(true);
				const credits = page.getByRole("region", { name: "重置额度", exact: true });
				await expect(credits.getByRole("listitem")).toHaveCount(3);
				await expect(credits.getByText("3 次可用", { exact: true })).toBeVisible();
				await expect(credits.getByText("5 天 14 小时", { exact: true })).toBeVisible();
				await expect(credits.locator("details, .report-metrics")).toHaveCount(0);
				expect(await credits.locator("dd").evaluateAll((items) => items.every((item) => Number.parseFloat(getComputedStyle(item).fontSize) >= Number.parseFloat(getComputedStyle(document.documentElement).fontSize)))).toBe(true);
			}
			for (const theme of ["light", "dark"] as const) {
				await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
				await page.screenshot({ path: path.resolve("dist", `gui-report-${name}-${info.project.name}-${theme}.png`), fullPage: true });
			}
			for (const summary of await page.locator("details > summary").all()) await summary.click();
			for (const width of [viewport?.width ?? 1200, 320]) {
				await page.setViewportSize({ width, height: viewport?.height ?? 820 });
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
				expect(await page.locator(".report-dashboard").evaluate((root) => [...root.querySelectorAll(".report-metric, .report-bar, .report-facts, .reset-credits dl, .usage-reset")].every((element) => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
			}
			if (viewport) await page.setViewportSize(viewport);
		}
	} finally {
		await app.close();
	}
});
