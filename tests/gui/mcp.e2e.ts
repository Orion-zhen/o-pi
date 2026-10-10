import { configureModel } from "./model-fixture.ts";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixture.ts";
import { writeMcpFixture } from "./mcp-fixture.ts";
import { startModelServer } from "../cli/model-server.ts";

test.describe("MCP", () => {
	let model: Awaited<ReturnType<typeof startModelServer>>;
	test.beforeEach(async ({ workspace: { cwd, agentDir } }) => {
		const script = await writeMcpFixture(cwd, { resources: true });
		await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
			fixture: { command: process.execPath, args: [script], exposure: "codemode" },
			other: { command: process.execPath, args: [script], exposure: "codemode" },
		} }));
		model = await startModelServer((request) => {
			const lastUser = request.messages.findLastIndex((message) => message.role === "user");
			return request.messages.slice(lastUser + 1).some((message) => message.role === "tool") ? { text: "MCP 检查完成" }
				: { tool: "codemode", args: { code: 'text(await searchTools("MCP_VISIBILITY", {namespace:"mcp__fixture"}));' } };
		});
		await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
		await configureModel(agentDir, model.url, "fixture", { reasoning: false, settings: { defaultTools: ["codemode"] } });
	});
	test.afterEach(async () => { await model?.close(); });

	test("MCP 服务行随容器和字号换行，不横向溢出", async ({ gui: { page } }) => {
		await page.locator(".tool-count").click();
		const selection = page.locator(".tool-selection-mcp");
		await expect(selection).toBeVisible();
		for (const fontSize of ["100%", "150%", "200%"]) {
			await selection.evaluate((element, size) => { element.style.fontSize = size; }, fontSize);
			await expect.poll(() => selection.locator(".mcp-tool-group-row").evaluateAll((rows) => rows.length > 0 && rows.every((row) =>
				row.scrollWidth <= row.clientWidth && [...row.children].every((child) => child.scrollWidth <= child.clientWidth),
			))).toBe(true);
		}
		await page.getByRole("button", { name: "展开 fixture", exact: true }).click();
		await expect(page.getByRole("checkbox", { name: "mcp__fixture__probe", exact: true })).toBeVisible();
	});

	test("服务开关与资源独立，批量操作包含共享资源", async ({ gui: { page } }) => {
		await page.locator(".tool-count").click();
		const server = page.getByRole("checkbox", { name: "fixture 服务工具", exact: true });
		const other = page.getByRole("checkbox", { name: "other 服务工具", exact: true });
		const probe = page.getByRole("checkbox", { name: "mcp__fixture__probe", exact: true });
		const refresh = page.getByRole("checkbox", { name: "mcp__fixture__refresh", exact: true });
		const resource = page.getByRole("checkbox", { name: "read_mcp_resource", exact: true });
		await page.getByRole("button", { name: "展开 fixture", exact: true }).click();
		await expect(server).toBeChecked();
		await probe.click();
		await server.click();
		await expect(refresh).toBeDisabled();
		await expect(refresh).not.toBeChecked();
		await expect(resource).toBeChecked();
		await page.getByRole("button", { name: "收起 fixture", exact: true }).click();
		await expect(probe).not.toBeVisible();
		await expect(server).not.toBeChecked();
		await page.getByRole("button", { name: "展开 fixture", exact: true }).press("Space");
		await server.click();
		await expect(probe).not.toBeChecked();
		await expect(refresh).toBeChecked();
		await resource.click();
		const all = page.getByRole("checkbox", { name: "MCP 服务工具", exact: true });
		await expect(all).toHaveAttribute("aria-checked", "mixed");
		await all.click();
		await expect(all).toBeChecked();
		await page.locator(".mcp-selection-heading label").click();
		await expect(server).not.toBeChecked();
		await expect(other).not.toBeChecked();
		await expect(all).toHaveAttribute("aria-checked", "false");
		await all.click();
		await expect(server).toBeChecked();
		await expect(other).toBeChecked();
		await expect(probe).not.toBeChecked();
		await expect(resource).toBeChecked();
		const search = page.getByRole("textbox", { name: "筛选工具", exact: true });
		await search.fill("fixture");
		await expect(all).toBeChecked();
		await all.click();
		await expect(server).not.toBeChecked();
		await search.fill("");
		await expect(other).toBeChecked();
	});

	test("选择器关闭 MCP 工具阻止模型发现，刷新保留选择，配置仅显式保存", async ({ gui: { page }, workspace: { agentDir } }) => {
		const name = "mcp__fixture__probe";
		const file = path.join(agentDir, "mcp.json");
		const original = await readFile(file, "utf8");
		await page.locator(".tool-count").click();
		await page.getByRole("button", { name: "展开 fixture", exact: true }).click();
		const checkbox = page.getByRole("checkbox", { name, exact: true });
		await expect(checkbox).toBeChecked();
		await checkbox.click();
		await expect(checkbox).not.toBeChecked();
		await page.getByRole("button", { name: "关闭面板", exact: true }).click();
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("关闭后搜索");
		await editor.press("ControlOrMeta+Enter");
		await expect(page.locator(".reply-answer")).toContainText("MCP 检查完成");
		expect(JSON.stringify(model.requests.at(-1)?.tools)).not.toContain(name);
		expect(JSON.stringify(model.requests.at(-1)?.messages.findLast((message) => message.role === "tool"))).not.toContain(name);
		expect(await readFile(file, "utf8")).toBe(original);
		await page.reload();
		await page.locator(".tool-count").click();
		await page.getByRole("button", { name: "展开 fixture", exact: true }).click();
		await expect(checkbox).not.toBeChecked();
		await checkbox.click();
		await expect(checkbox).toBeChecked();
		await page.getByRole("button", { name: "关闭面板", exact: true }).click();
		await editor.fill("启用后搜索");
		await editor.press("ControlOrMeta+Enter");
		await expect(page.locator(".reply-answer")).toHaveCount(2);
		await expect(page.locator(".reply-answer").last()).toContainText("MCP 检查完成");
		// 脚本模式通过搜索结果发现 MCP 工具，不直接声明它们。
		expect(JSON.stringify(model.requests.at(-1)?.tools)).not.toContain(name);
		expect(JSON.stringify(model.requests.at(-1)?.messages.findLast((message) => message.role === "tool"))).toContain(name);
		await editor.fill("/mcp");
		await editor.press("ControlOrMeta+Enter");
		const settings = page.getByRole("dialog", { name: "设置", exact: true });
		await settings.getByRole("region", { name: "MCP 服务", exact: true }).getByRole("button", { name: "JSON", exact: true }).click();
		const config = settings.getByRole("textbox", { name: "全局 MCP JSON", exact: true });
		await expect(config).toHaveValue(original);
		await expect(settings.getByRole("button", { name: "重连", exact: true })).toHaveCount(0);
		await config.fill("{}");
		expect(await readFile(file, "utf8")).toBe(original);
		await settings.getByRole("button", { name: "保存", exact: true }).click();
		await expect(settings.getByRole("status")).toHaveText("已保存");
		expect(await readFile(file, "utf8")).toBe("{}");
		await settings.getByRole("button", { name: "关闭面板", exact: true }).click();
		await page.locator(".tool-count").click();
		await page.getByRole("button", { name: "展开 fixture", exact: true }).click();
		await expect(checkbox).toBeChecked();
	});
});
