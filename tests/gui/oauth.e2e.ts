import { test, expect } from "./fixture.ts";

for (const mode of ["web", "desktop"] as const) test.describe(mode, () => {
	test.use({ mode });
	test("OAuth 打开认证页面，可取消和重试", async ({ gui: { app, page } }) => {
		let opened = "";
		if (mode === "desktop") await app.evaluate(({ shell }) => {
			shell.openExternal = async (url) => { process.env.OPI_TEST_OAUTH_URL = url; };
		});
		else await app.context().route("https://claude.ai/**", async (route) => {
			opened = route.request().url();
			await route.fulfill({ contentType: "text/html", body: "OAuth provider test page" });
		});
		for (let attempt = 0; attempt < 2; attempt++) {
			await page.locator(".welcome").getByRole("button", { name: "添加模型服务", exact: true }).click();
			const auth = page.getByRole("dialog", { name: "认证", exact: true });
			await auth.locator(".list-row").filter({ hasText: /^Anthropic/ }).getByRole("button", { name: "OAuth", exact: true }).click();
			await expect.poll(async () => mode === "desktop" ? app.evaluate(() => process.env.OPI_TEST_OAUTH_URL) : opened).toContain("oauth");
			await page.getByRole("button", { name: "取消登录", exact: true }).click();
			await expect(page.locator(".auth-banner")).toHaveCount(0);
			await expect(page.locator(".error-banner")).toHaveCount(0);
			opened = "";
			if (mode === "desktop") await app.evaluate(() => { delete process.env.OPI_TEST_OAUTH_URL; });
		}
	});
});
