import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixture.ts";
import { writeMcpFixture } from "./mcp-fixture.ts";
import { startModelServer } from "../cli/model-server.ts";

test.describe("MCP", () => {
	let model: Awaited<ReturnType<typeof startModelServer>>;
	test.beforeEach(async ({ workspace: { cwd, agentDir } }) => {
		const script = await writeMcpFixture(cwd);
		await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
			fixture: { command: process.execPath, args: [script], exposure: "codemode" },
		} }));
		model = await startModelServer((request) => {
			const lastUser = request.messages.findLastIndex((message) => message.role === "user");
			return request.messages.slice(lastUser + 1).some((message) => message.role === "tool") ? { text: "MCP 检查完成" }
				: { tool: "codemode", args: { code: 'text(await searchTools("MCP_VISIBILITY", {namespace:"mcp__fixture"}));' } };
		});
		await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
		await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
			defaultProjectTrust: "never", defaultProvider: "fixture", defaultModel: "test", defaultTools: ["codemode"],
			compaction: { enabled: false }, retry: { enabled: false },
		}));
		await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
			baseUrl: model.url, api: "openai-completions", apiKey: "fixture",
			models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		} } }));
	});
	test.afterEach(async () => { await model?.close(); });

	test("选择器关闭 MCP 工具阻止模型发现，刷新保留选择，配置仅显式保存", async ({ gui: { page }, workspace: { agentDir } }) => {
		const name = "mcp__fixture__probe";
		const file = path.join(agentDir, "mcp.json");
		const original = await readFile(file, "utf8");
		await page.locator(".tool-count").click();
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
		await expect(checkbox).toBeChecked();
	});
});
