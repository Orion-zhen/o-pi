import { test, expect } from "@playwright/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { liveSnapshot, replayTranscript } from "./transcript-live-fixture.ts";
import { assistant } from "./transcript-fixtures.ts";

interface LiveMeasurement { active: boolean; frames: number[]; tasks: number[]; clicks: number[] }
declare global { interface Window { liveTranscriptPerf: LiveMeasurement } }
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)] ?? 0;

test("工具详情随视口与字号伸缩，焦点留白覆盖轮廓", async ({ page }) => {
	const channel = await replayTranscript(page, liveSnapshot());
	try {
		const reply = page.locator('.assistant-reply[data-state="running"]');
		await expect(reply).toBeVisible();
		await reply.locator('.reply-activity > .disclosure-trigger').first().click();
		const summary = reply.locator('.activity-summary').first();
		await summary.click();
		for (const fontSize of ["100%", "125%", "150%"]) {
			await page.evaluate((value) => { document.documentElement.style.fontSize = value; }, fontSize);
			await summary.scrollIntoViewIfNeeded();
			await page.keyboard.press("Tab");
			await summary.focus();
			const layout = await summary.evaluate((element) => {
				const card = element.closest<HTMLElement>(".tool-activity");
				const viewport = element.closest<HTMLElement>(".transcript");
				if (!card || !viewport) throw new Error("缺少工具卡片或滚动容器");
				const style = getComputedStyle(element);
				const cardStyle = getComputedStyle(card);
				return { width: card.getBoundingClientRect().width, viewport: viewport.clientWidth, contain: cardStyle.contain,
					margin: parseFloat(cardStyle.overflowClipMargin), outline: parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset) };
			});
			expect(layout.width).toBeLessThanOrEqual(layout.viewport);
			expect(layout.contain).toBe("paint");
			expect(layout.margin).toBeGreaterThanOrEqual(layout.outline);
			await expect(summary).toHaveAttribute("aria-expanded", "true");
		}
	} finally { channel.close(); }
});

for (const mode of ["idle", "stream", "progress"] as const) test(`长轮次在 ${mode} 更新下展开、滚动和复制`, async ({ page, context }, info) => {
	test.skip(info.project.name !== "desktop", "CPU 限速对照固定桌面视口");
	const snapshot = liveSnapshot();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.addInitScript(() => {
		const state: LiveMeasurement = window.liveTranscriptPerf = { active: false, frames: [], tasks: [], clicks: [] };
		let last = 0;
		const frame = (time: number) => { if (state.active && last) state.frames.push(time - last); last = time; requestAnimationFrame(frame); };
		requestAnimationFrame(frame);
		new PerformanceObserver((list) => { if (state.active) state.tasks.push(...list.getEntries().map((entry) => entry.duration)); }).observe({ type: "longtask" });
		document.addEventListener("click", () => {
			if (!state.active) return;
			const start = performance.now();
			requestAnimationFrame(() => requestAnimationFrame(() => state.clicks.push(performance.now() - start)));
		}, true);
	});
	const cdp = await context.newCDPSession(page);
	await cdp.send("Performance.enable");
	await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
	const channel = await replayTranscript(page, snapshot);
	let timer: ReturnType<typeof setInterval> | undefined;
	try {
		const reply = page.locator('.assistant-reply[data-state="running"]');
		await expect(reply).toBeVisible();
		await reply.locator('.reply-process[data-state="closed"] > .disclosure-trigger').evaluateAll((buttons) => buttons.forEach((button) => { if (button instanceof HTMLElement) button.click(); }));
		const summaries = reply.locator('.tool-activity[data-tool="read"] .activity-summary');
		await expect(summaries).toHaveCount(220);
		for (let index = 0; index < 8; index++) await summaries.nth(index).click();
		await page.waitForTimeout(400);
		const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((metric) => [metric.name, metric.value]));
		const before = await metrics();
		await page.evaluate(() => { window.liveTranscriptPerf.active = true; });
		let updates = 0;
		const start = performance.now();
		if (mode !== "idle") timer = setInterval(() => {
			updates++;
			if (mode === "stream") channel.accept({ type: "stream", sessionId: snapshot.sessionId,
				value: { ...assistant([{ type: "thinking", thinking: "继续检查。".repeat(updates) }], "pending"), timestamp: 1000 } });
			else channel.accept({ type: "snapshot", value: { ...snapshot, streamingMessage: null, liveTools: [{
				toolCallId: "live", toolName: "bash", args: { command: "fixture-progress" }, status: "running",
				output: { kind: "inline", value: { content: [{ type: "text", text: `执行进度 ${updates}` }] } },
			}] } });
		}, 25);
		for (let index = 0; index < 12; index++) {
			await summaries.nth(index < 8 ? index : index + 4).click();
			await page.mouse.move(620, 350);
			await page.mouse.wheel(0, index % 2 ? -440 : 440);
			await page.waitForTimeout(240);
		}
		clearInterval(timer);
		await page.waitForTimeout(300);
		const elapsed = performance.now() - start;
		const after = await metrics();
		const data = await page.evaluate(() => { window.liveTranscriptPerf.active = false; return { ...window.liveTranscriptPerf, nodes: document.querySelectorAll("*").length }; });
		const measurement = { mode, elapsed, updates, nodes: data.nodes, longTasks: data.tasks.length, maxTask: Math.max(0, ...data.tasks),
			frameP95: percentile(data.frames, .95), clickP95: percentile(data.clicks, .95),
			scriptMs: ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000,
			layoutMs: ((after.LayoutDuration ?? 0) - (before.LayoutDuration ?? 0)) * 1000,
			taskMs: ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000 };
		await info.attach("live-measurement", { body: JSON.stringify({ measurement, data }), contentType: "application/json" });
		console.log(JSON.stringify(measurement));
		expect(data.clicks).toHaveLength(12);
		expect(measurement.maxTask).toBeLessThan(500);

		const first = summaries.first();
		await expect(first).toHaveAttribute("aria-expanded", "false");
		await first.scrollIntoViewIfNeeded();
		await page.keyboard.press("Tab");
		await first.focus();
		await expect(first).toBeFocused();
		const bounds = await first.boundingBox();
		if (!bounds) throw new Error("缺少工具摘要尺寸");
		const outline = await first.evaluate((element) => {
			const style = getComputedStyle(element);
			return parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth) / 2;
		});
		const focused = await page.screenshot({ animations: "disabled" });
		await first.evaluate((element) => element.blur());
		const unfocused = await page.screenshot({ animations: "disabled" });
		const pixel = async (image: Buffer) => {
			const bitmap = await loadImage(image);
			const canvas = createCanvas(bitmap.width, bitmap.height);
			const painter = canvas.getContext("2d");
			painter.drawImage(bitmap, 0, 0);
			return [...painter.getImageData(Math.floor(bounds.x - outline), Math.floor(bounds.y + bounds.height / 2), 1, 1).data];
		};
		expect(await pixel(focused), "卡片外的键盘焦点轮廓仍可见").not.toEqual(await pixel(unfocused));
		await first.click();
		const tool = page.locator('[data-tool-call-id="read-0"]');
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await tool.getByRole("button", { name: "复制module-0.ts:1–60", exact: true }).click();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('export const value0 = { index: 0, text: "检查状态 0" };');
		const reader = page.locator(".transcript");
		await reader.evaluate((element) => {
			const code = element.querySelector('[data-tool-call-id="read-0"] pre');
			if (!code) throw new Error("缺少工具正文");
			const range = document.createRange(); range.selectNodeContents(code);
			const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
		});
		const selected = await page.evaluate(() => document.getSelection()?.toString());
		const top = await reader.evaluate((element) => element.scrollTop);
		channel.accept({ type: "stream", sessionId: snapshot.sessionId, value: { ...assistant([{ type: "thinking", thinking: "新的进度" }], "pending"), timestamp: 1000 } });
		await expect.poll(() => reply.locator(".thinking-content").last().textContent()).toContain("新的进度");
		expect(await reader.evaluate((element) => element.scrollTop)).toBeCloseTo(top, 0);
		expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(selected);
		await expect(first).toHaveAttribute("aria-expanded", "true");
		expect(errors).toEqual([]);
	} finally { clearInterval(timer); channel.close(); }
});
