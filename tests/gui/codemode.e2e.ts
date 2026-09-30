import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixture.ts";
import { startModelServer } from "../cli/model-server.ts";

for (const mode of ["web", "desktop"] as const) {
	test.describe(`codemode ${mode}`, () => {
		test.use({ mode });
		let model: Awaited<ReturnType<typeof startModelServer>>;
		test.beforeEach(async ({ workspace: { cwd, agentDir } }, info) => {
			test.skip(mode === "desktop" && info.project.name !== "desktop", "桌面入口只需验证一次");
			model = await startModelServer((request) => request.messages?.some((message) => message.role === "tool")
				? { text: "嵌套验证完成" }
				: { tool: "codemode", args: { code: 'const r = await tools.find({query:"sample"}); try { await tools.read({path:"missing.ts"}); } catch {} await tools.script_probe({}); text(r.matches[0].path);' } });
			await mkdir(path.join(agentDir, "extensions"), { recursive: true });
			await writeFile(path.join(agentDir, "extensions", "probe.ts"), `export default (pi) => {
				for (const [name, exposure] of [["script_probe", "codemode"], ["deferred_probe", "deferred"]]) pi.registerTool({
					name, label: name, exposure, description: "Wait for a background operation.", parameters: { type: "object", properties: {} },
					async execute() { await new Promise(resolve => setTimeout(resolve, 2500)); return { content: [{ type: "text", text: "ready" }] }; }
				});
			}`);
			await writeFile(path.join(cwd, "sample.ts"), "export const value = 1;\n");
			await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
			await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
				defaultProjectTrust: "never", defaultProvider: "fixture", defaultModel: "test",
				defaultTools: ["read", "find", "skill", "subagent", "codemode", "script_probe", "deferred_probe"], codemode: { mode: "on" },
				compaction: { enabled: false }, retry: { enabled: false },
			}));
			await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
				api: "openai-completions", baseUrl: model.url, apiKey: "fixture",
				models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			} } }));
		});
		test.afterEach(async () => { await model?.close(); });

		test("可用工具计数、层级选择与实时调用在刷新后保持一致", async ({ gui: { page } }, info) => {
			const counter = page.locator(".tool-count");
			await expect(counter.locator(".lucide-code-xml")).toHaveCount(1);
			await counter.click();
			const panel = page.getByRole("dialog");
			await expect(panel.locator('.tool-selection-children [data-tool-option="find"]')).toBeVisible();
			await expect(panel.locator('.tool-selection > [data-tool-option="skill"]')).toBeVisible();
			await expect(panel.locator('[data-tool-option="script_probe"] [role="checkbox"]')).toHaveCount(0);
			const codemodeCount = await panel.locator('[role="checkbox"][aria-checked="true"]:not([aria-label="codemode"])').count()
				+ await panel.locator(".tool-callable-state").count();
			await expect(counter).toHaveText(String(codemodeCount));
			await panel.getByRole("checkbox", { name: "skill", exact: true }).click();
			await expect(counter).toHaveText(String(codemodeCount - 1));
			await panel.getByRole("checkbox", { name: "skill", exact: true }).click();
			await expect(counter).toHaveText(String(codemodeCount));
			await panel.getByRole("checkbox", { name: "find", exact: true }).click();
			await expect(panel.getByRole("checkbox", { name: "find", exact: true })).not.toBeChecked();
			await expect(counter).toHaveText(String(codemodeCount - 1));
			await panel.getByRole("checkbox", { name: "codemode", exact: true }).click();
			await expect(panel.getByRole("checkbox", { name: "codemode", exact: true })).not.toBeChecked();
			const normalCount = await panel.locator('[role="checkbox"][aria-checked="true"]').count();
			await expect(counter).toHaveText(String(normalCount));
			await expect(counter.locator(".lucide-wrench")).toHaveCount(1);
			await expect(panel.locator(".tool-selection-children")).toHaveCount(0);
			await expect(panel.getByRole("checkbox", { name: "find", exact: true })).not.toBeChecked();
			await panel.getByRole("checkbox", { name: "find", exact: true }).click();
			await expect(panel.getByRole("checkbox", { name: "find", exact: true })).toBeChecked();
			await expect(counter).toHaveText(String(normalCount + 1));
			for (const name of ["script_probe", "deferred_probe"]) {
				await expect(panel.getByRole("checkbox", { name, exact: true })).toBeChecked();
				await panel.getByRole("checkbox", { name, exact: true }).click();
				await expect(panel.getByRole("checkbox", { name, exact: true })).not.toBeChecked();
			}
			await expect(counter).toHaveText(String(normalCount - 1));
			await panel.getByRole("checkbox", { name: "codemode", exact: true }).click();
			await expect(panel.getByRole("checkbox", { name: "codemode", exact: true })).toBeChecked();
			await expect(counter).toHaveText(String(codemodeCount));
			for (const name of ["script_probe", "deferred_probe"]) {
				const child = panel.locator(`.tool-selection-children [data-tool-option="${name}"]`);
				await expect(child).toContainText("可调用");
				await expect(child.locator('[role="checkbox"]')).toHaveCount(0);
			}
			await page.screenshot({ path: info.outputPath("tool-selection.png") });
			await page.getByRole("button", { name: "关闭面板", exact: true }).click();
			const editor = page.getByRole("textbox", { name: "消息", exact: true });
			await editor.fill("查找 sample 文件");
			await editor.press("ControlOrMeta+Enter");
			const tool = page.locator('[data-tool="codemode"]');
			await expect(tool.locator('[data-nested-tool-call-id] .activity-summary[title="script_probe"]')).toBeVisible();
			await expect(tool.locator('[data-nested-tool-call-id]:has([title="find"])')).toHaveAttribute("data-state", "completed");
			await expect(tool.locator('[data-nested-tool-call-id]:has([title="read"])')).toHaveAttribute("data-state", "failed");
			await expect(tool.locator('.tool-parameters > .disclosure-trigger').first()).toHaveAttribute("aria-expanded", "false");
			await page.screenshot({ path: info.outputPath("codemode-running.png") });
			await expect(page.locator(".reply-answer")).toContainText("嵌套验证完成");
			const request = model.requests.find((request) => Array.isArray(request.messages));
			expect(request?.tools?.map((tool) => tool.function.name).sort()).toEqual(["codemode", "skill", "subagent"]);
			const description = request?.tools?.find((tool) => tool.function.name === "codemode")?.function.description;
			expect(description).toContain("find(args:");
			expect(description).not.toContain("Model API");
			expect(description).toContain("searchTools");
			await expect(counter).toHaveText(String(codemodeCount));
			const toolResult = model.requests.findLast((request) => Array.isArray(request.messages))?.messages.find((message) => message.role === "tool");
			expect(JSON.stringify(toolResult)).toContain("sample.ts");
			expect(JSON.stringify(toolResult)).not.toContain("Script failed");
			await page.reload();
			await expect(counter).toHaveText(String(codemodeCount));
			await expect(page.locator(".reply-answer")).toContainText("嵌套验证完成");
			await page.locator(".assistant-reply .reply-activity > .disclosure-trigger").click();
			await tool.locator(':scope > [data-slot="collapsible"] > .activity-summary').click();
			await expect(tool).toHaveAttribute("data-state", "completed");
			await expect(tool.locator(".nested-failures")).toContainText("1 次失败");
			await expect(tool.locator("[data-nested-tool-call-id]")).toHaveCount(3);
			await expect(tool.locator('[data-nested-tool-call-id]:has([title="find"])')).toContainText("sample");
			await tool.locator(".codemode-output > .disclosure-trigger").click();
			await expect(tool.locator(".codemode-output")).toContainText("sample.ts");
			await counter.click();
			await panel.getByRole("checkbox", { name: "codemode", exact: true }).click();
			await expect(panel.getByRole("checkbox", { name: "codemode", exact: true })).not.toBeChecked();
			await page.getByRole("button", { name: "关闭面板", exact: true }).click();
			await expect(tool.locator("[data-nested-tool-call-id]")).toHaveCount(3);
			await expect(page.locator('.tool-activity[data-tool="find"]')).toHaveCount(0);
			await editor.fill("普通模式继续");
			await editor.press("ControlOrMeta+Enter");
			await expect.poll(() => model.requests.findLast((request) => Array.isArray(request.messages))?.tools?.length).toBe(normalCount - 1);
			expect(model.requests.findLast((request) => Array.isArray(request.messages))?.tools).toHaveLength(Number(await counter.textContent()));
		});
	});
}
