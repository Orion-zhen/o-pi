import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "jsonc-parser";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixture.ts";
import { selectSettingsCategory } from "./settings-steps.ts";

const settings = (page: Page) => page.getByRole("dialog", { name: "设置", exact: true });
const providers = (page: Page) => settings(page).getByRole("region", { name: "搜索引擎", exact: true });
const labels = (page: Page) => providers(page).getByRole("listitem").locator(".search-provider-name");
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
	await expect(labels(page)).toHaveText(["Brave", "Exa", "Tavily", "TinyFish", "AnySearch"]);
	await expect(providers(page).locator(".settings-description")).toHaveCount(0);
	for (const row of await providers(page).getByRole("listitem").all()) {
		await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	}
	await providers(page).getByRole("switch", { name: "Exa", exact: true }).uncheck();
	await expect(providers(page).getByRole("button", { name: "上移 Brave", exact: true })).toBeDisabled();
	await expect(providers(page).getByRole("button", { name: "下移 Tavily", exact: true })).toBeDisabled();
	await providers(page).getByRole("list", { name: "主搜索引擎顺序", exact: true }).scrollIntoViewIfNeeded();
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
	await expect(labels(page)).toHaveText(["Exa", "Brave", "Tavily", "TinyFish", "AnySearch"]);
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
		primary_providers: ["exa_api", "brave_api", "tavily"], exa_api: { enabled: false },
	} });
	await page.reload();
	await open(page);
	await expect(labels(page)).toHaveText(["Exa", "Brave", "Tavily", "TinyFish", "AnySearch"]);
	await expect(providers(page).getByRole("switch", { name: "Exa", exact: true })).not.toBeChecked();
});

test("键盘排序、放弃和恢复默认共享设置草稿，减少动态效果时仍可操作", async ({ gui: { page }, workspace: { agentDir } }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const file = path.join(agentDir, "configs", "web-tools.jsonc");
	await writeFile(file, JSON.stringify({ websearch: {
		primary_providers: ["exa_api", "brave_api", "tavily"], exa_api: { enabled: false },
	} }));
	await open(page);
	const down = providers(page).getByRole("button", { name: "下移 Exa", exact: true });
	await down.press("Enter");
	await expect(labels(page)).toHaveText(["Brave", "Exa", "Tavily", "TinyFish", "AnySearch"]);
	await expect(down).toBeFocused();
	await expect(providers(page).getByRole("switch", { name: "Exa", exact: true })).not.toBeChecked();
	await settings(page).getByRole("button", { name: "放弃", exact: true }).click();
	await expect(labels(page)).toHaveText(["Exa", "Brave", "Tavily", "TinyFish", "AnySearch"]);
	await providers(page).getByRole("button", { name: "重置搜索引擎分组", exact: true }).click();
	await providers(page).getByRole("button", { name: "重置Exa", exact: true }).click();
	await expect(labels(page)).toHaveText(["Brave", "Exa", "Tavily", "TinyFish", "AnySearch"]);
	await expect(providers(page).getByRole("switch", { name: "Exa", exact: true })).toBeChecked();
	await save(page);
	const saved = parse(await readFile(file, "utf8"));
	expect(saved).not.toHaveProperty("websearch.primary_providers");
	expect(saved).not.toHaveProperty("websearch.exa_api.enabled");
});

test("逐项展开 schema 详情，排序保留展开状态，修改支持保存、重置和放弃", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "configs", "web-tools.jsonc");
	await writeFile(file, "{}\n");
	await open(page);
	const engines = providers(page);
	const textbox = (name: string) => engines.getByRole("textbox", { name, exact: true });
	const number = (name: string) => engines.getByRole("spinbutton", { name, exact: true });
	await expect(textbox("接口地址")).toHaveCount(0);
	await engines.getByRole("switch", { name: "Brave", exact: true }).uncheck();
	await expect(engines.getByRole("button", { name: "展开 Brave", exact: true })).toHaveAttribute("aria-expanded", "false");
	await engines.getByRole("button", { name: "编辑 Brave", exact: true }).click();
	await expect(textbox("接口地址")).toHaveValue("https://api.search.brave.com/res/v1/web/search");
	await expect(textbox("API Key")).toBeEnabled();
	await expect(textbox("API Key")).toHaveAttribute("maxlength", "4096");
	await expect(number("超时（秒）")).toHaveAttribute("min", "1");
	await expect(number("超时（秒）")).toHaveAttribute("max", "60");
	await expect(number("超时（秒）")).toHaveAttribute("step", "1");
	await textbox("API Key").fill("$CUSTOM_BRAVE_KEY");
	await number("超时（秒）").fill("12");
	await engines.getByRole("switch", { name: "额外摘要", exact: true }).check();
	await engines.getByRole("button", { name: "下移 Brave", exact: true }).click();
	await expect(labels(page)).toHaveText(["Exa", "Brave", "Tavily", "TinyFish", "AnySearch"]);
	await expect(engines.getByRole("button", { name: "收起 Brave", exact: true })).toHaveAttribute("aria-expanded", "true");
	await expect(textbox("API Key")).toHaveValue("$CUSTOM_BRAVE_KEY");
	await engines.getByRole("button", { name: "展开 Exa", exact: true }).click();
	await expect(engines.getByRole("button", { name: "展开 Brave", exact: true })).toHaveAttribute("aria-expanded", "false");
	await expect(number("摘要长度（字符）")).toHaveValue("600");
	await number("摘要长度（字符）").fill("800");
	await engines.getByRole("button", { name: "展开 Tavily", exact: true }).click();
	await expect(textbox("接口地址")).toHaveValue("https://api.tavily.com/search");
	expect(await engines.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await engines.screenshot({ path: test.info().outputPath("search-provider-details.png"), animations: "disabled" });
	await save(page);
	expect(parse(await readFile(file, "utf8"))).toMatchObject({ websearch: {
		primary_providers: ["exa_api", "brave_api", "tavily"],
		brave_api: { enabled: false, api_key: "$CUSTOM_BRAVE_KEY", timeout_seconds: 12, extra_snippets: true },
		exa_api: { highlight_chars: 800 },
	} });
	await page.reload();
	await open(page);
	await engines.getByRole("button", { name: "展开 Brave", exact: true }).click();
	await expect(textbox("API Key")).toHaveValue("$CUSTOM_BRAVE_KEY");
	await expect(number("超时（秒）")).toHaveValue("12");
	await textbox("API Key").fill("discard-this");
	await settings(page).getByRole("button", { name: "放弃", exact: true }).click();
	await expect(textbox("API Key")).toHaveValue("$CUSTOM_BRAVE_KEY");
	await engines.getByRole("button", { name: "重置API Key", exact: true }).click();
	await expect(textbox("API Key")).toHaveValue("$BRAVE_SEARCH_API_KEY");
	await save(page);
	expect(parse(await readFile(file, "utf8"))).not.toHaveProperty("websearch.brave_api.api_key");
});

test("主辅分组与两层条数限制可保存、重新读取并一起重置", async ({ gui: { page }, workspace: { agentDir } }) => {
	const file = path.join(agentDir, "configs", "web-tools.jsonc");
	await writeFile(file, "{}\n");
	await open(page);
	const engines = providers(page);
	const primary = engines.getByRole("list", { name: "主搜索引擎顺序", exact: true });
	const auxiliary = engines.getByRole("list", { name: "辅助搜索引擎顺序", exact: true });
	await expect(primary.locator(".search-provider-name")).toHaveText(["Brave", "Exa", "Tavily"]);
	await expect(auxiliary.locator(".search-provider-name")).toHaveText(["TinyFish", "AnySearch"]);
	const spacing = await engines.locator(".search-provider-settings").evaluate((element) => {
		const heading = element.querySelector("h3");
		if (!heading) throw new Error("缺少分组标题");
		const card = element.closest(".settings-section-body");
		if (!card) throw new Error("缺少搜索引擎卡片");
		return {
			top: heading.getBoundingClientRect().top - card.getBoundingClientRect().top,
			inset: parseFloat(getComputedStyle(card).paddingInlineStart),
		};
	});
	expect(spacing.top).toBeGreaterThanOrEqual(spacing.inset);
	await engines.getByRole("button", { name: "设为辅助引擎 Exa", exact: true }).click();
	await expect(primary.locator(".search-provider-name")).toHaveText(["Brave", "Tavily"]);
	await expect(auxiliary.locator(".search-provider-name")).toHaveText(["TinyFish", "AnySearch", "Exa"]);
	await engines.getByRole("button", { name: "上移 Exa", exact: true }).click();
	await engines.getByRole("button", { name: "上移 Exa", exact: true }).click();
	await engines.getByRole("button", { name: "展开 TinyFish", exact: true }).click();
	await expect(engines.getByRole("textbox", { name: "API Key", exact: true })).toHaveValue("$TINYFISH_API_KEY");
	await engines.getByRole("spinbutton", { name: "结果条数上限", exact: true }).fill("3");
	await settings(page).getByRole("spinbutton", { name: "总结果条数上限", exact: true }).fill("12");
	expect(await engines.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	await save(page);
	expect(parse(await readFile(file, "utf8"))).toMatchObject({ websearch: {
		primary_providers: ["brave_api", "tavily"], auxiliary_providers: ["exa_api", "tinyfish", "anysearch"],
		default_results: 12, tinyfish: { max_results: 3 },
	} });
	await page.reload();
	await open(page);
	await expect(auxiliary.locator(".search-provider-name")).toHaveText(["Exa", "TinyFish", "AnySearch"]);
	await engines.getByRole("button", { name: "设为主引擎 TinyFish", exact: true }).click();
	await expect(primary.locator(".search-provider-name")).toHaveText(["Brave", "Tavily", "TinyFish"]);
	await settings(page).getByRole("button", { name: "放弃", exact: true }).click();
	await expect(auxiliary.locator(".search-provider-name")).toHaveText(["Exa", "TinyFish", "AnySearch"]);
	await engines.getByRole("button", { name: "重置搜索引擎分组", exact: true }).click();
	await expect(auxiliary.locator(".search-provider-name")).toHaveText(["TinyFish", "AnySearch"]);
	await save(page);
	const saved = parse(await readFile(file, "utf8"));
	expect(saved).not.toHaveProperty("websearch.primary_providers");
	expect(saved).not.toHaveProperty("websearch.auxiliary_providers");
	expect(saved).toMatchObject({ websearch: { default_results: 12, tinyfish: { max_results: 3 } } });
});

test("整行标题空白可展开，独立按钮和详情表单不会误触收起", async ({ gui: { page }, workspace: { agentDir } }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await writeFile(path.join(agentDir, "configs", "web-tools.jsonc"), "{}\n");
	await open(page);
	const engines = providers(page);
	const row = engines.getByRole("listitem").filter({ has: page.getByRole("button", { name: "编辑 Brave", exact: true }) });
	const heading = row.locator(".search-provider-heading");
	const toggle = row.getByRole("button", { name: "编辑 Brave", exact: true });
	await heading.scrollIntoViewIfNeeded();
	const blank = await heading.evaluate((element) => {
		const heading = element.getBoundingClientRect();
		const name = element.querySelector(".search-provider-name");
		const actions = element.querySelector(".search-provider-actions");
		if (!name || !actions) throw new Error("缺少标题控件");
		return { x: (name.getBoundingClientRect().right + actions.getBoundingClientRect().left) / 2 - heading.left, y: heading.height / 2 };
	});
	await heading.click({ position: blank });
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await row.getByRole("textbox", { name: "接口地址", exact: true }).click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await heading.click({ position: { x: blank.x, y: 2 } });
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	const gap = await heading.evaluate((element) => {
		const heading = element.getBoundingClientRect();
		const buttons = element.querySelectorAll(".search-provider-actions > button");
		const up = buttons[1]?.getBoundingClientRect();
		const down = buttons[2]?.getBoundingClientRect();
		if (!up || !down) throw new Error("缺少排序按钮");
		return { x: (up.right + down.left) / 2 - heading.left, y: heading.height / 2 };
	});
	await heading.click({ position: gap });
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await row.getByRole("button", { name: "收起 Brave", exact: true }).click();
	await row.getByRole("switch", { name: "Brave", exact: true }).uncheck();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await row.getByRole("button", { name: "重置Brave", exact: true }).click();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	const disabledUp = await row.getByRole("button", { name: "上移 Brave", exact: true }).boundingBox();
	if (!disabledUp) throw new Error("缺少排序按钮位置");
	await page.mouse.click(disabledUp.x + disabledUp.width / 2, disabledUp.y + disabledUp.height / 2);
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await row.getByRole("button", { name: "下移 Brave", exact: true }).click();
	await expect(labels(page)).toHaveText(["Exa", "Brave", "Tavily", "TinyFish", "AnySearch"]);
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await toggle.press("Enter");
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await toggle.press("Space");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
});
