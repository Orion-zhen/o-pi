import { configureModel } from "./model-fixture.ts";
import type { Locator } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./fixture.ts";
import { startModelServer, type ModelRequest, type ModelResponse } from "../cli/model-server.ts";

let model: Awaited<ReturnType<typeof startModelServer>>;
let respond: (request: ModelRequest) => Promise<ModelResponse>;

async function animationStates(target: Locator) {
	return target.evaluate((element) => element.getAnimations({ subtree: true })
		.filter((animation) => animation instanceof CSSAnimation && animation.animationName.startsWith("reply-"))
		.map((animation) => animation.playState));
}

test.beforeEach(async ({ workspace: { agentDir, cwd } }) => {
	model = await startModelServer((request) => respond(request));
	await writeFile(path.join(cwd, "example.txt"), "等待下一轮输出");
	await configureModel(agentDir, model.url, "breathing-test", { reasoning: false });
	await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
});
test.afterEach(async () => { await model?.close(); });

for (const text of ["", "先检查文件。"])
	test(`等待模型及工具后续回复时持续变形，完成后退出（${text ? "含中途正文" : "仅工具"}）`, async ({ gui: { page } }) => {
		const tool = Promise.withResolvers<ModelResponse>();
		const answer = Promise.withResolvers<ModelResponse>();
		respond = (request) => request.messages.some((message) => message.role === "tool") ? answer.promise : tool.promise;
		await page.getByRole("textbox", { name: "消息", exact: true }).fill("读取 example.txt 后总结");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		const indicator = page.getByRole("status", { name: "正在处理", exact: true });
		await expect(indicator).toBeVisible();
		const original = await indicator.elementHandle();
		if (!original) throw new Error("缺少活动标记");
		const shape = indicator.locator("path");
		const initial = await shape.getAttribute("d");
		await expect.poll(() => shape.getAttribute("d")).not.toBe(initial);
		tool.resolve({ tool: "read", args: { path: "example.txt" }, text });
		await expect(page.locator('.tool-activity[data-state="completed"]')).toBeVisible();
		await expect.poll(() => model.requests.some((request) => request.messages?.some((message) => message.role === "tool"))).toBe(true);
		if (text) {
			const process = page.locator('.assistant-reply > .reply-process');
			const summary = process.locator(':scope > .disclosure-trigger .reply-status-label');
			const nested = process.locator('.reply-activity .reply-status-label');
			await expect.poll(() => animationStates(nested)).toEqual(["running"]);
			await process.locator(':scope > .disclosure-trigger').click();
			await expect(process).toHaveAttribute("data-state", "closed");
			await expect.poll(() => animationStates(nested)).toEqual(["paused"]);
			await expect.poll(() => animationStates(summary)).toEqual(["running"]);
			await process.locator(':scope > .disclosure-trigger').click();
			await process.locator(':scope > [data-slot="collapsible-content"] > .collapse-content').evaluate(async (element) => {
				await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
			});
			await nested.scrollIntoViewIfNeeded();
			await expect(nested).toBeInViewport();
			await expect.poll(() => animationStates(nested)).toEqual(["running"]);
		}
		await indicator.scrollIntoViewIfNeeded();
		await expect(indicator).toBeVisible();
		expect(await original.evaluate((element) => element.isConnected)).toBe(true);
		const afterTool = await shape.getAttribute("d");
		await expect.poll(() => shape.getAttribute("d")).not.toBe(afterTool);
		answer.resolve({ text: "读取完成" });
		await expect(page.locator('.assistant-reply[data-state="completed"]')).toContainText("读取完成");
		await expect(indicator).toHaveCount(0);
	});

test("流式正文期间显示活动标记，正文完成后移除", async ({ gui: { page } }) => {
	const chunks = ["检查结果：\n\n", ...Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 项检查完成。\n\n`)];
	respond = async () => ({ text: chunks.join(""), chunks, intervalMs: 100 });
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("逐项汇报检查结果");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator('.assistant-reply[data-state="running"] .reply-answer')).toContainText("第 1 项检查完成。");
	const indicator = page.getByRole("status", { name: "正在处理", exact: true });
	await expect(indicator).toBeVisible();
	await expect(page.locator('.assistant-reply[data-state="completed"] .reply-answer')).toContainText("第 20 项检查完成。");
	await expect(indicator).toHaveCount(0);
});

test("滚出视口暂停过程动画，返回后恢复且扫光不作用于回复容器", async ({ gui: { page } }) => {
	const answer = Promise.withResolvers<ModelResponse>();
	respond = () => answer.promise;
	try {
		await page.getByRole("textbox", { name: "消息", exact: true }).fill("用于滚动检查的历史内容。\n\n".repeat(80));
		await page.getByRole("button", { name: "发送", exact: true }).click();
		const indicator = page.getByRole("status", { name: "正在处理", exact: true });
		await expect.poll(() => animationStates(indicator)).toEqual(["running", "running", "running"]);
		const reader = page.locator(".transcript");
		await reader.evaluate((element) => { element.scrollTop = 0; });
		await expect(indicator).not.toBeInViewport();
		await expect.poll(() => animationStates(indicator)).toEqual(["paused", "paused", "paused"]);
		const shape = indicator.locator("path");
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		const pausedPath = await shape.getAttribute("d");
		await page.waitForTimeout(250);
		expect(await shape.getAttribute("d")).toBe(pausedPath);
		await page.getByRole("button", { name: "回到最新", exact: true }).click();
		await expect(indicator).toBeInViewport();
		await expect.poll(() => animationStates(indicator)).toEqual(["running", "running", "running"]);
		await expect.poll(() => shape.getAttribute("d")).not.toBe(pausedPath);
		const animations = await page.locator('.assistant-reply[data-state="running"]').evaluate((element) => element.getAnimations({ subtree: true })
			.filter((animation): animation is CSSAnimation => animation instanceof CSSAnimation && animation.animationName.startsWith("reply-"))
			.map((animation) => ({ name: animation.animationName, start: animation.startTime,
				label: animation.effect instanceof KeyframeEffect && animation.effect.target instanceof Element && animation.effect.target.matches(".reply-status-label") })));
		expect(animations.filter((animation) => animation.name === "reply-shimmer").every((animation) => animation.label)).toBe(true);
		expect(animations.every((animation) => animation.start === 0)).toBe(true);
	} finally { answer.resolve({ text: "检查完成" }); }
});

test("页面隐藏时暂停，重新显示后恢复过程动画", async ({ gui: { page } }) => {
	const answer = Promise.withResolvers<ModelResponse>();
	respond = () => answer.promise;
	try {
		await page.getByRole("textbox", { name: "消息", exact: true }).fill("等待检查页面可见性");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		const indicator = page.getByRole("status", { name: "正在处理", exact: true });
		await expect.poll(() => animationStates(indicator)).toEqual(["running", "running", "running"]);
		// 无头浏览器不切换系统窗口，在文档边界模拟后台标签页通知。
		await page.evaluate(() => {
			Object.defineProperty(document, "hidden", { configurable: true, value: true });
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await expect.poll(() => animationStates(indicator)).toEqual(["paused", "paused", "paused"]);
		const shape = indicator.locator("path");
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		const pausedPath = await shape.getAttribute("d");
		await page.waitForTimeout(250);
		expect(await shape.getAttribute("d")).toBe(pausedPath);
		await page.evaluate(() => {
			Reflect.deleteProperty(document, "hidden");
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await expect.poll(() => animationStates(indicator)).toEqual(["running", "running", "running"]);
		await expect.poll(() => shape.getAttribute("d")).not.toBe(pausedPath);
	} finally { answer.resolve({ text: "检查完成" }); }
});

test("停止请求后移除活动标记", async ({ gui: { page } }) => {
	const answer = Promise.withResolvers<ModelResponse>();
	respond = () => answer.promise;
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("稍等再回答");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	const indicator = page.getByRole("status", { name: "正在处理", exact: true });
	await expect(indicator).toBeVisible();
	await page.getByRole("button", { name: "停止", exact: true }).click();
	await expect(indicator).toHaveCount(0);
	await expect(page.locator('.assistant-reply[data-state="stopped"]')).toContainText("已停止");
	answer.resolve({ text: "已取消" });
});
