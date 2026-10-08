import type { Page } from "@playwright/test";
import { startWebProcess } from "./web-process.ts";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { test as base, expect } from "./workspace.ts";

export const test = base.extend<{ gui: { page: Page } }>({
	gui: async ({ workspace: { home, cwd, env }, page }, use) => {
		const name = process.platform === "win32" ? "opi-web.exe" : "opi-web";
		const binary = path.join(home, name);
		await copyFile(process.env.OPI_GUI_TEST_BINARY ?? path.resolve("dist/web", name), binary);
		const backend = startWebProcess(cwd, env, binary);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		try {
			await page.goto(await backend.ready());
			await use({ page });
			expect(errors).toEqual([]);
		} finally {
			try { await page.context().close(); }
			finally { await backend.close(); }
		}
	},
});
export { expect };
