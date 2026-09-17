import { test, expect, _electron as electron } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("干净配置：引导认证、保留草稿、选择模型后恢复欢迎页", async ({ viewport }, info) => {
	const home = await mkdtemp(path.join(os.tmpdir(), "opi-onboarding-"));
	const cwd = path.join(home, "workspace");
	const agentDir = path.join(home, ".pi", "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(path.join(agentDir, "configs"), { recursive: true });
	await writeFile(path.join(agentDir, "settings.json"), '{"defaultProjectTrust":"never"}');
	await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
	const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
		entry[1] !== undefined && /^(PATH|DISPLAY|XAUTHORITY|LD_LIBRARY_PATH|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/.test(entry[0])));
	Object.assign(env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NODE_ENV: "test" });
	const child = spawn(path.resolve("dist/web", process.platform === "win32" ? "opi-web.exe" : "opi-web"), ["--cwd", cwd, "--host", "127.0.0.1", "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
	try {
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		await expect.poll(() => output.match(/opi-web: (http:\/\/[^\s]+)/)?.[1]).toBeTruthy();
		const url = output.match(/opi-web: (http:\/\/[^\s]+)/)?.[1];
		if (!url) throw new Error("缺少测试服务地址");
		const app = await electron.launch({ args: [path.resolve("tests/gui/web-browser.cjs"), "--no-sandbox"], cwd, env });
		try {
			const page = await app.firstWindow();
			if (viewport) await page.setViewportSize(viewport);
			await page.goto(url);
			await expect(page.getByRole("heading", { name: "连接模型" })).toBeVisible();
			await expect(page.getByRole("button", { name: "了解项目", exact: true })).toHaveCount(0);
			await expect(page.getByRole("button", { name: "添加模型服务", exact: true })).toHaveCount(1);
			await expect(page.getByText("发送消息前，请先配置模型服务。")).toHaveCount(0);
			await page.screenshot({ path: `dist/gui-onboarding-${info.project.name}.png` });
			const editor = page.getByRole("textbox", { name: "消息", exact: true });
			await editor.fill("保留这条草稿");
			await editor.press("Control+Enter");
			const auth = page.getByRole("dialog", { name: "认证", exact: true });
			await expect(auth).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(editor).toHaveValue("保留这条草稿");
			await expect(page.locator(".message.user")).toHaveCount(0);
			await editor.fill("/name 尚未配置也能使用命令");
			await editor.press("Control+Enter");
			await expect(page.locator(".topbar .session-name")).toHaveText("尚未配置也能使用命令");
			await page.locator(".welcome").getByRole("button", { name: "添加模型服务", exact: true }).click();
			const provider = auth.locator(".list-row").filter({ hasText: /^Anthropic/ });
			await provider.getByRole("button", { name: "API Key", exact: true }).click();
			await page.getByLabel("输入内容", { exact: true }).fill("onboarding-test-key");
			await page.getByRole("button", { name: "提交", exact: true }).click();
			await expect(provider).toHaveAttribute("data-authenticated", "true");
			await page.keyboard.press("Escape");
			await expect(page.getByRole("heading", { name: "开始对话" })).toBeVisible();
			await page.locator(".welcome").getByRole("button", { name: "选择模型", exact: true }).click();
			await page.getByRole("button", { name: /^使用模型 anthropic\// }).first().click();
			await page.keyboard.press("Escape");
			await expect(page.getByRole("heading", { name: "今天，想构建什么？" })).toBeVisible();
			await expect(page.getByRole("button", { name: "了解项目", exact: true })).toBeVisible();
			await expect(page.getByText("发送消息前，请先配置模型服务。")).toHaveCount(0);
			await page.reload();
			await expect(editor).toBeVisible();
			await expect(page.getByRole("heading", { name: "连接模型" })).toHaveCount(0);
		} finally { await app.close(); }
	} finally {
		child.kill("SIGTERM");
		await new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
		await rm(home, { recursive: true, force: true });
	}
});
