import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixture.ts";
import { selectSettingsCategory } from "./settings-steps.ts";

async function open(page: Page) {
	if ((page.viewportSize()?.width ?? 1200) < 768) await page.getByRole("button", { name: "菜单", exact: true }).click();
	await page.getByRole("button", { name: "设置", exact: true }).click();
	await selectSettingsCategory(page, "工具与代码");
	return page.getByRole("region", { name: "LSP 服务器", exact: true });
}

const isServerRequest = (body: string | null) => body?.includes('"lspServers"') === true;

test("LSP 设置只检查命令，折叠支持键盘，刷新读取安装结果而非草稿", async ({ gui: { page }, workspace: { cwd, agentDir } }) => {
	const marker = path.join(cwd, "lsp-started");
	const command = [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`];
	const newCommand = `./new-lsp${process.platform === "win32" ? ".exe" : ""}`;
	const servers = {
		local: { enabled: false, command, languages: { typescript: "*.ts" } },
		missing: { command: [newCommand], languages: { python: "*.py" } },
	};
	await writeFile(path.join(agentDir, "configs", "lsp.jsonc"), JSON.stringify({ servers }));
	const project = path.join(cwd, ".pi", "configs");
	await mkdir(project, { recursive: true });
	await writeFile(path.join(project, "lsp.jsonc"), JSON.stringify({ servers: {
		local: { languages: { javascript: "*.js" } },
		remote: { tcp: { host: "127.0.0.1", port: 2087 }, languages: { go: "*.go" } },
	} }));
	let queries = 0;
	page.on("request", (request) => { if (request.url().endsWith("/api/query") && isServerRequest(request.postData())) queries++; });
	const section = await open(page);
	const local = section.getByRole("article", { name: "LSP 服务器 local", exact: true });
	const missing = section.getByRole("article", { name: "LSP 服务器 missing", exact: true });
	await expect(local.getByText("可用", { exact: true })).toBeVisible();
	await expect(local).toContainText("typescript, javascript");
	await expect(section.getByRole("article")).toHaveCount(3);
	await expect(missing.getByText("不可用", { exact: true })).toBeVisible();
	await expect(section).toContainText(path.join(project, "lsp.jsonc"));
	const trigger = local.getByRole("button", { name: "查看 local 详情", exact: true });
	await trigger.focus();
	await trigger.press("Enter");
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	await expect(local.getByText(JSON.stringify(command), { exact: true })).toBeVisible();
	await expect(local.getByText(process.execPath, { exact: true })).toBeVisible();
	await trigger.press("Enter");
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	await expect(local.locator("[data-slot=collapsible-content]")).toHaveAttribute("inert", "");
	const remote = section.getByRole("article", { name: "LSP 服务器 remote", exact: true });
	await expect(remote.getByRole("button")).toContainText("TCP");
	await remote.getByRole("button").click();
	await expect(remote.getByText("127.0.0.1:2087", { exact: true })).toBeVisible();

	await page.getByRole("region", { name: "代码智能", exact: true }).getByRole("button", { name: "JSONC", exact: true }).click();
	await page.getByRole("textbox", { name: "lsp 全局 JSONC", exact: true }).fill(JSON.stringify({ servers: {
		...servers, local: { ...servers.local, command: ["definitely-missing-draft-lsp"] },
	} }));
	await writeFile(path.resolve(cwd, newCommand), "not executed", { mode: 0o755 });
	const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/query") && isServerRequest(response.request().postData()));
	await section.getByRole("button", { name: "刷新", exact: true }).click();
	await refreshed;
	await expect(local.getByText("可用", { exact: true })).toBeVisible();
	await expect(missing.getByText("可用", { exact: true })).toBeVisible();
	await expect(page.getByRole("textbox", { name: "lsp 全局 JSONC", exact: true })).toContainText("definitely-missing-draft-lsp");
	await selectSettingsCategory(page, "网络与网页");
	await selectSettingsCategory(page, "工具与代码");
	await expect.poll(() => queries).toBe(3);
	await expect(section.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
	await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(section).not.toContainText(/未启动|启动中|就绪|已停止|已崩溃/);
	expect(await section.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("LSP 命令查询失败可刷新重试，缺失命令展示修复提示", async ({ gui: { page }, workspace: { agentDir } }) => {
	await writeFile(path.join(agentDir, "configs", "lsp.jsonc"), JSON.stringify({ servers: {
		missing: { command: ["definitely-missing-gui-lsp"], languages: { typescript: "*.ts" } },
	} }));
	let fail = true;
	await page.route("**/api/query", async (route) => {
		if (!isServerRequest(route.request().postData())) return route.continue();
		if (fail) { fail = false; return route.fulfill({ status: 503, body: "命令检查暂时失败" }); }
		return route.continue();
	});
	const section = await open(page);
	await expect(section.getByRole("alert")).toHaveText("命令检查暂时失败");
	await section.getByRole("button", { name: "刷新", exact: true }).click();
	await expect(section.getByRole("article")).toHaveCount(1);
	await expect(section.getByRole("article").getByText("不可用", { exact: true })).toBeVisible();
	const trigger = section.getByRole("button", { name: "查看 missing 详情", exact: true });
	await trigger.click();
	await expect(section.getByText('["definitely-missing-gui-lsp"]', { exact: true })).toBeVisible();
	await expect(section.getByText("请确认命令已安装，且 GUI 后端能通过 PATH 或配置路径找到它。", { exact: true })).toBeVisible();
	await expect(section.getByRole("alert")).toHaveCount(0);
	await trigger.click();
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
});
