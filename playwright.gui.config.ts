import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "tests/gui",
	testMatch: "**/*.e2e.ts",
	timeout: 60_000,
	expect: { timeout: 15_000 },
	workers: 1,
	projects: [
		{ name: "desktop", use: { viewport: { width: 1200, height: 820 } } },
		{ name: "phone", use: { viewport: { width: 390, height: 844 } } },
	],
});
