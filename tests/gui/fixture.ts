import type { Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { test as base, expect } from "./workspace.ts";

export const test = base.extend<{ gui: { page: Page } }>({
	gui: async ({ workspace: { home, cwd, env }, page }, use) => {
		const name = process.platform === "win32" ? "opi-web.exe" : "opi-web";
		const binary = path.join(home, name);
		await copyFile(process.env.OPI_GUI_TEST_BINARY ?? path.resolve("dist/web", name), binary);
		const child = spawn(binary, ["--cwd", cwd, "--host", "127.0.0.1", "--port", "0"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		try {
			let url = "";
			await expect.poll(() => { url = output.match(/opi-web: (http:\/\/[^\s]+)/)?.[1] ?? ""; return url; }, { message: "opi-web 启动" }).toBeTruthy();
			await page.goto(url);
			await use({ page });
			expect(errors).toEqual([]);
		} finally {
			try { await page.context().close(); }
			finally { await terminate(child); }
		}
	},
});
export { expect };

async function terminate(child: ChildProcess) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
		child.once("exit", () => { clearTimeout(timer); resolve(); });
		child.kill("SIGTERM");
	});
}
