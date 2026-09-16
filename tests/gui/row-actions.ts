import type { Locator } from "@playwright/test";

export async function clickRowAction(button: Locator, options?: Parameters<Locator["click"]>[0]) {
	await button.locator("..").locator("..").hover();
	await button.click(options);
}
