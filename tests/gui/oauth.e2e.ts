import { test, expect } from "./fixture.ts";

test("OAuth 打开认证页面，可取消和重试", async ({ gui: { page } }) => {
	let opened = "";
	await page.context().route("https://claude.ai/**", async (route) => {
		opened = route.request().url();
		await route.fulfill({ contentType: "text/html", body: "OAuth provider test page" });
	});
	for (let attempt = 0; attempt < 2; attempt++) {
		await page.locator(".welcome").getByRole("button", { name: "添加模型服务", exact: true }).click();
		const auth = page.getByRole("dialog", { name: "认证", exact: true });
		await auth.locator(".list-row").filter({ hasText: /^Anthropic/ }).getByRole("button", { name: "OAuth", exact: true }).click();
		await expect.poll(() => opened).toContain("oauth");
		await page.getByRole("button", { name: "取消登录", exact: true }).click();
		await expect(page.locator(".auth-banner")).toHaveCount(0);
		await expect(page.locator(".error-banner")).toHaveCount(0);
		opened = "";
	}
});
