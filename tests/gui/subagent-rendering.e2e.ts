import { configureModel } from "./model-fixture.ts";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixture.ts";
import { startModelServer } from "../cli/model-server.ts";

let model: Awaited<ReturnType<typeof startModelServer>>;
test.beforeEach(async ({ workspace: { agentDir } }) => {
	model = await startModelServer((request) => {
		const user = JSON.stringify(request.messages.findLast((message) => message.role === "user")?.content);
		if (user?.includes("CHILD_RENDER")) return {
			text: "", intervalMs: 80,
			chunks: ["```ts\nconst answer = 42;\n```\n\n", ...Array.from({ length: 75 }, (_, index) => `子任务进度-${index}，保持正文完整。\n\n`), "CHILD_COMPLETE"],
		};
		if (request.messages.at(-1)?.role === "tool") return { text: "主任务完成" };
		return { tool: "subagent", args: { tasks: [{ agent: "gui-worker", task: "CHILD_RENDER" }] } };
	});
	await configureModel(agentDir, model.url, "subagent-test", { reasoning: false });
	await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
	await mkdir(path.join(agentDir, "agents"), { recursive: true });
	await writeFile(path.join(agentDir, "agents", "gui-worker.md"), "---\nname: gui-worker\ndescription: GUI 流式渲染验证\ntools: read\nauto_confirm: true\nretries: 0\n---\n完成子任务。\n");
});
test.afterEach(async () => { await model?.close(); });

test("子任务折叠时不更新详情，重新展开显示完整最新内容", async ({ gui: { page } }) => {
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("启动子任务");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	const task = page.locator('.subagent-task[data-state="running"]').first();
	const summary = task.locator(".subagent-task-summary");
	await expect(task.locator(".subagent-current")).toContainText("子任务进度");
	await expect(task.locator(".subagent-task-body")).toHaveCount(0);
	await summary.click();
	const output = task.locator(".subagent-output");
	await expect(output).toContainText("子任务进度");
	await expect(output.locator(".token")).toHaveCount(0);
	await summary.click();
	const body = task.locator(".subagent-task-body");
	await expect(summary).toHaveAttribute("aria-expanded", "false");
	const previous = await body.textContent();
	const progress = await task.locator(".subagent-current").textContent();
	await expect.poll(() => task.locator(".subagent-current").textContent()).not.toBe(progress);
	expect(await body.textContent()).toBe(previous);
	await summary.click();
	await expect.poll(() => body.textContent()).not.toBe(previous);
	await expect(page.locator(".reply-answer")).toContainText("主任务完成");
	// 主回复完成后过程自动折叠，重新展开检查最终内容与高亮。
	const reply = page.locator('.assistant-reply[data-state="completed"]');
	const activity = reply.locator(".reply-activity");
	await activity.locator(":scope > .disclosure-trigger").click();
	const tool = page.locator('.tool-activity[data-tool="subagent"]');
	await tool.locator(".activity-summary").click();
	const final = tool.locator('.subagent-task[data-state="completed"]');
	await expect(final.locator(".subagent-output")).toContainText("CHILD_COMPLETE");
	await expect(final.locator(".subagent-output .token").first()).toBeVisible();
});
