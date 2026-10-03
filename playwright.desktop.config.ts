import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "tests/gui",
	testMatch: ["**/desktop-*.e2e.ts", "**/desktop-*.integration.ts"],
	timeout: 120_000,
	expect: { timeout: 15_000 },
	workers: 1,
	use: { headless: true, viewport: { width: 1200, height: 820 } },
});
