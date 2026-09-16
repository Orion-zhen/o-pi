import { expect, type Locator, type Page } from "@playwright/test";

export async function clickRowAction(button: Locator, options?: Parameters<Locator["click"]>[0]) {
	await button.locator("..").locator("..").hover();
	await button.click(options);
}

export async function expectRowActionOverlay(page: Page, row: Locator) {
	await row.scrollIntoViewIfNeeded();
	await page.mouse.move(0, 0);
	const before = await row.locator(":scope > button").boundingBox();
	await row.hover();
	const layout = await row.evaluate((element) => {
		const content = element.querySelector(":scope > button");
		const actions = element.querySelector(".row-actions");
		if (!content || !actions) throw new Error("缺少列表项或操作区");
		const row = element.getBoundingClientRect();
		const body = content.getBoundingClientRect();
		const tools = actions.getBoundingClientRect();
		const target = document.elementFromPoint(tools.right - tools.width / 4, tools.top + tools.height / 2);
		return {
			width: body.width,
			fullWidth: Math.abs(body.left - row.left) < 1 && Math.abs(body.right - row.right) < 1,
			overlaps: tools.left < body.right && tools.right <= body.right + 1 && tools.top < body.bottom,
			onTop: target !== null && actions.contains(target),
			position: getComputedStyle(actions).position,
		};
	});
	expect(layout.fullWidth).toBe(true);
	expect(layout.overlaps).toBe(true);
	expect(layout.onTop).toBe(true);
	expect(layout.position).toBe("static");
	expect(layout.width).toBeCloseTo(before?.width ?? 0);
}
