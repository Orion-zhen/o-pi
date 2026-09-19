import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type Workspace = { home: string; cwd: string; agentDir: string; env: Record<string, string> };
export const test = base.extend<{
	mode: "web" | "desktop";
	workspace: Workspace;
	gui: { app: ElectronApplication; page: Page };
}>({
	mode: ["web", { option: true }],
	workspace: async ({}, use) => {
		const home = await mkdtemp(path.join(os.tmpdir(), "opi-gui-e2e-"));
		const cwd = path.join(home, "workspace");
		const agentDir = path.join(home, ".pi", "agent");
		try {
			await mkdir(cwd);
			await mkdir(path.join(agentDir, "configs"), { recursive: true });
			await writeFile(path.join(agentDir, "settings.json"), '{"defaultProjectTrust":"never"}');
			await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
			const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
				entry[1] !== undefined && /^(PATH|DISPLAY|XAUTHORITY|LD_LIBRARY_PATH|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|SYSTEMROOT|WINDIR|TEMP|TMP)$/.test(entry[0])));
			Object.assign(env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NODE_ENV: "test", XDG_CONFIG_HOME: path.join(home, "config") });
			await use({ home, cwd, agentDir, env });
		} finally { await rm(home, { recursive: true, force: true }); }
	},
	gui: async ({ workspace: { home, cwd, env }, mode, viewport }, use) => {
		let child: ChildProcess | undefined;
		let app: ElectronApplication | undefined;
		try {
			let url = "";
			let entry = path.resolve("tests/gui/web-browser.cjs");
			if (mode === "web") {
				const name = process.platform === "win32" ? "opi-web.exe" : "opi-web";
				const binary = path.join(home, name);
				await copyFile(process.env.OPI_GUI_TEST_BINARY ?? path.resolve("dist/web", name), binary);
				child = spawn(binary, ["--cwd", cwd, "--host", "127.0.0.1", "--port", "0"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
				let output = "";
				child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
				child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
				await expect.poll(() => { url = output.match(/opi-web: (http:\/\/[^\s]+)/)?.[1] ?? ""; return url; }, { message: "opi-web 启动" }).toBeTruthy();
			} else {
				entry = path.join(home, "desktop-app");
				await cp(path.resolve("dist/desktop/app"), entry, { recursive: true });
			}
			app = await electron.launch({ args: [entry, "--no-sandbox"], cwd, env, acceptDownloads: true });
			const page = await app.firstWindow();
			if (viewport) await page.setViewportSize(viewport);
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			if (url) await page.goto(url);
			else {
				// 桌面从 HOME 启动，通过公开操作进入测试工作区。
				await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible();
				await page.evaluate(async (cwd) => {
					if (!window.opi) throw new Error("缺少桌面连接");
					await window.opi.send({ action: "workspace", path: cwd }, null);
				}, cwd);
			}
			await use({ app, page });
			expect(errors).toEqual([]);
		} finally {
			try {
				// 失败的测试可能留下未保存草稿，销毁测试窗口以跳过 beforeunload。
				if (app) {
					await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); });
					await app.close();
				}
			}
			finally { if (child) await terminate(child); }
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
