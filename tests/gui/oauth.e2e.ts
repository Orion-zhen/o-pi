import { test, expect, _electron as electron } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

for (const transport of ["web", "desktop"] as const) {
	test(`${transport}: OAuth 自动打开浏览器，不出现重定向输入框，可取消和重试`, async ({ viewport }) => {
		const home = await mkdtemp(path.join(os.tmpdir(), "opi-oauth-"));
		const cwd = path.join(home, "workspace");
		const agentDir = path.join(home, ".pi", "agent");
		await mkdir(cwd, { recursive: true });
		await mkdir(path.join(agentDir, "configs"), { recursive: true });
		await writeFile(path.join(agentDir, "settings.json"), '{"defaultProjectTrust":"never"}');
		await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
		const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
			entry[1] !== undefined && /^(PATH|DISPLAY|XAUTHORITY|LD_LIBRARY_PATH|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/.test(entry[0])));
		Object.assign(env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NODE_ENV: "test" });
		let child: ChildProcess | undefined;
		try {
			let url = "";
			if (transport === "web") {
				child = spawn(path.resolve("dist/web", process.platform === "win32" ? "opi-web.exe" : "opi-web"), ["--cwd", cwd, "--host", "127.0.0.1", "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
				let output = "";
				child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
				child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
				await expect.poll(() => output.match(/opi-web: (http:\/\/[^\s]+)/)?.[1]).toBeTruthy();
				url = output.match(/opi-web: (http:\/\/[^\s]+)/)?.[1] ?? "";
			}
			const app = await electron.launch({ args: [path.resolve(transport === "web" ? "tests/gui/web-browser.cjs" : "dist/desktop/app"), "--no-sandbox"], cwd, env });
			try {
				let opened = "";
				if (transport === "desktop") {
					await app.evaluate(({ shell }) => {
						shell.openExternal = async (url) => { process.env.OPI_TEST_OAUTH_URL = url; };
					});
				} else {
					await app.context().route("https://claude.ai/**", async (route) => {
						opened = route.request().url();
						await route.fulfill({ contentType: "text/html", body: "OAuth provider test page" });
					});
				}
				const page = await app.firstWindow();
				if (viewport) await page.setViewportSize(viewport);
				if (transport === "web") await page.goto(url);
				for (let attempt = 0; attempt < 2; attempt++) {
					await page.locator(".welcome").getByRole("button", { name: "添加模型服务", exact: true }).click();
					const auth = page.getByRole("dialog", { name: "认证", exact: true });
					await auth.locator(".list-row").filter({ hasText: /^Anthropic/ }).getByRole("button", { name: "OAuth", exact: true }).click();
					await expect(auth).toHaveCount(0);
					const banner = page.locator(".auth-banner");
					await expect(banner.getByRole("link", { name: "打开认证页面" })).toBeVisible();
					await expect.poll(async () => transport === "desktop"
						? app.evaluate(() => process.env.OPI_TEST_OAUTH_URL)
						: opened).toContain("oauth");
					await expect(page.getByRole("dialog")).toHaveCount(0);
					await expect(page.getByLabel("输入内容", { exact: true })).toHaveCount(0);
					await banner.getByRole("button", { name: "取消登录", exact: true }).click();
					await expect(banner).toHaveCount(0);
					await expect(page.locator(".error-banner")).toHaveCount(0);
					opened = "";
					if (transport === "desktop") await app.evaluate(() => { delete process.env.OPI_TEST_OAUTH_URL; });
				}
			} finally { await app.close(); }
		} finally {
			if (child && child.exitCode === null && child.signalCode === null) {
				const exited = new Promise<void>((resolve) => child?.once("exit", () => resolve()));
				child.kill("SIGTERM");
				await exited;
			}
			await rm(home, { recursive: true, force: true });
		}
	});
}
