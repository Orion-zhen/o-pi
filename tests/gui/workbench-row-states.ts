import { expect, type Locator, type Page } from "@playwright/test";

export async function expectActionHighlight(button: Locator) {
	const row = button.locator("xpath=../..");
	await row.hover();
	await expect(button.locator("..")).toHaveCSS("opacity", "1");
	const idle = await button.evaluate((element) => getComputedStyle(element).backgroundColor);
	await button.hover();
	await expect.poll(() => button.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(idle);
	const background = await row.evaluate((element) => getComputedStyle(element).backgroundColor);
	expect(await button.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(background);
	await button.focus();
	await expect(button).toBeFocused();
	await expect(button.locator("..")).toHaveCSS("opacity", "1");
}

export async function expectGitContrast(page: Page, tree: Locator) {
	for (const colorScheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme });
		for (const path of ["src/main.ts", "引用 空格.md", "deleted.txt"]) {
			const item = tree.getByRole("treeitem", { name: path, exact: true });
			await item.hover();
			const contrast = await item.evaluate((element) => {
				const name = element.querySelector(".file-name");
				const status = element.querySelector(".git-status");
				if (!name || !status) throw new Error("缺少文件名或 Git 状态");
				const luminance = (color: string) => {
					const channels = color.match(/[\d.]+/g);
					if (!channels || channels.length < 3) throw new Error(`无效颜色: ${color}`);
					return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
						const value = Number(channels[index]) / 255;
						return sum + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) * weight;
					}, 0);
				};
				const text = getComputedStyle(name).color;
				const foreground = luminance(text);
				const background = luminance(getComputedStyle(element).backgroundColor);
				return { ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
					colored: text !== getComputedStyle(element).color, matching: text === getComputedStyle(status).color };
			});
			expect(contrast.colored).toBe(true);
			expect(contrast.matching).toBe(true);
			expect(contrast.ratio, `${colorScheme}: ${path}`).toBeGreaterThanOrEqual(4.5);
		}
	}
}
