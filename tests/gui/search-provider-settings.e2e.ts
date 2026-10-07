import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "jsonc-parser";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixture.ts";
import { selectSettingsCategory } from "./settings-steps.ts";

const settings = (page: Page) => page.getByRole("dialog", { name: "设置", exact: true });
const providers = (page: Page) => settings(page).getByRole("region", { name: "搜索引擎", exact: true });
const labels = (page: Page) => providers(page).getByRole("listitem").locator("label");
async function open(page: Page) {
	if ((page.viewportSize()?.width ?? 1200) < 768) await page.getByRole("button", { name: "菜单", exact: true }).click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await selectSettingsCategory(page, "网络与网页");
}
async function save(page: Page) {
	await settings(page).getByRole("button", { name: "保存", exact: true }).click();
	await expect(settings(page).locator(".settings-actions").getByRole("status")).toHaveText("已保存");
}

test("搜索引擎按钮排序带位移动画，启停与顺序保存后可重新读取", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "configs", "web-tools.jsonc");
	await writeFile(file, "{}\n");
	await open(page);
	await expect(labels(page)).toHaveText(["Brave", "Exa", "Tavily", "DuckDuckGo"]);
	await expect(providers(page).locator(".search-provider-heading, .settings-description")).toHaveCount(0);
	for (const row of await providers(page).getByRole("listitem").all()) {
		await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	}
	await providers(page).getByRole("switch", { name: "Exa", exact: true }).uncheck();
	await expect(providers(page).getByRole("button", { name: "上移 Brave", exact: true })).toBeDisabled();
	await expect(providers(page).getByRole("button", { name: "下移 DuckDuckGo", exact: true })).toBeDisabled();
	await providers(page).getByRole("list").scrollIntoViewIfNeeded();
	const first = providers(page).getByRole("listitem").first();
	const animated = first.evaluate((element) => new Promise<boolean>((resolve) => {
		const deadline = performance.now() + 5000;
		const sample = () => {
			const transform = getComputedStyle(element).transform;
			if (transform !== "none" && Math.abs(new DOMMatrixReadOnly(transform).m42) > 1) resolve(true);
			else if (performance.now() > deadline) resolve(false);
			else requestAnimationFrame(sample);
		};
		requestAnimationFrame(sample);
	}));
	await providers(page).getByRole("button", { name: "上移 Exa", exact: true }).click();
	await expect(labels(page)).toHaveText(["Exa", "Brave", "Tavily", "DuckDuckGo"]);
	expect(await animated).toBe(true);
	await expect.poll(() => providers(page).getByRole("listitem").evaluateAll((rows) => rows.every((row) => {
		const transform = getComputedStyle(row).transform;
		return transform === "none" || new DOMMatrixReadOnly(transform).isIdentity;
	}))).toBe(true);
	await expect(providers(page).getByRole("switch", { name: "Exa", exact: true })).not.toBeChecked();
	expect(await providers(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await providers(page).screenshot({ path: test.info().outputPath("search-providers.png"), animations: "disabled" });
	await save(page);
	expect(parse(await readFile(file, "utf8"))).toMatchObject({ websearch: {
		provider_order: ["exa_api", "brave_api", "tavily", "duckduckgo_html"], exa_api: { enabled: false },
	} });
	await page.reload();
	await open(page);
	await expect(labels(page)).toHaveText(["Exa", "Brave", "Tavily", "DuckDuckGo"]);
	await expect(providers(page).getByRole("switch", { name: "Exa", exact: true })).not.toBeChecked();
});

test("键盘排序、放弃和恢复默认共享设置草稿，减少动态效果时仍可操作", async ({ gui: { page }, workspace: { agentDir } }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const file = path.join(agentDir, "configs", "web-tools.jsonc");
	await writeFile(file, JSON.stringify({ websearch: {
		provider_order: ["exa_api", "brave_api", "tavily", "duckduckgo_html"], exa_api: { enabled: false },
	} }));
	await open(page);
	const down = providers(page).getByRole("button", { name: "下移 Exa", exact: true });
	await down.press("Enter");
	await expect(labels(page)).toHaveText(["Brave", "Exa", "Tavily", "DuckDuckGo"]);
	await expect(down).toBeFocused();
	await expect(providers(page).getByRole("switch", { name: "Exa", exact: true })).not.toBeChecked();
	await settings(page).getByRole("button", { name: "放弃", exact: true }).click();
	await expect(labels(page)).toHaveText(["Exa", "Brave", "Tavily", "DuckDuckGo"]);
	await providers(page).getByRole("button", { name: "重置搜索引擎顺序", exact: true }).click();
	await providers(page).getByRole("button", { name: "重置Exa", exact: true }).click();
	await expect(labels(page)).toHaveText(["Brave", "Exa", "Tavily", "DuckDuckGo"]);
	await expect(providers(page).getByRole("switch", { name: "Exa", exact: true })).toBeChecked();
	await save(page);
	const saved = parse(await readFile(file, "utf8"));
	expect(saved).not.toHaveProperty("websearch.provider_order");
	expect(saved).not.toHaveProperty("websearch.exa_api.enabled");
});
