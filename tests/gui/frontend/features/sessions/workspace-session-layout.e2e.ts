import type { Locator } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "../../../helpers/workspace.ts";
import { storeSession } from "../../../helpers/session-fixture.ts";
import { startWebProcess } from "../../../../web/web-process.ts";
import { startModelServer, type ModelResponse } from "../../../../cli/model-server.ts";
import { deferred } from "../../../../helpers/async.ts";
import { GuiReceiver, type GuiDelivery } from "../../../../../src/gui/shared/protocol/sync.ts";
import type { GuiSessionInfo } from "../../../../../src/gui/shared/protocol/state.ts";

async function expectSeparateRows(rows: Locator): Promise<void> {
	await expect(rows).toHaveCount(2);
	await expect.poll(async () => {
		const [first, second] = await rows.evaluateAll((elements) => elements.map((element) => {
			const bounds = element.getBoundingClientRect();
			return { top: bounds.top, bottom: bounds.bottom };
		}));
		if (!first || !second) throw new Error("缺少运行会话行");
		return Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
	}, { message: "运行会话应分行显示" }).toBeLessThanOrEqual(0);
}

test("两个运行会话补齐历史、跨工作区往返后布局稳定", async ({ context, workspace: { home, cwd, agentDir, env } }, info) => {
	const other = path.join(home, "other");
	const response = deferred<ModelResponse>();
	const model = await startModelServer((request) => Array.isArray(request.messages) ? response.promise : { text: "" });
	const requests = () => model.requests.filter((request) => Array.isArray(request.messages)).length;
	let backend: ReturnType<typeof startWebProcess> | undefined;
	const errors: string[] = [];
	try {
		await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
			defaultProjectTrust: "never", defaultProvider: "gui-test", defaultModel: "test", enabledModels: ["gui-test/test"],
			compaction: { enabled: false }, retry: { enabled: false },
		}));
		await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
			"gui-test": { baseUrl: model.url, api: "openai-completions", apiKey: "fixture", models: [{
				id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}] },
		} }));
		await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
		for (let index = 0; index < 18; index++) await storeSession({
			cwd, agentDir, provider: "gui-test", name: `历史-${index}`, timestamp: 1000 + index,
		});
		await storeSession({ cwd: other, agentDir, provider: "gui-test", name: "其他工作区历史" });
		backend = startWebProcess(cwd, env);
		const page = await context.newPage();
		page.on("pageerror", (error) => errors.push(error.message));
		const receiver = new GuiReceiver();
		let sessions: GuiSessionInfo[] = [];
		page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
			const delivery: GuiDelivery = JSON.parse(payload.toString());
			if (delivery.kind !== "frame") return;
			for (const event of delivery.events) {
				const value = receiver.accept(event);
				if (value.type === "sessions") sessions = value.value;
			}
		}));
		await page.goto(await backend.ready());
		const phone = info.project.name === "phone";
		const navigation = page.locator(phone ? ".mobile-sidebar" : ".sidebar");
		const menu = async () => {
			if (phone && !await page.locator('.mobile-sidebar[data-state="open"]').count())
				await page.getByRole("button", { name: "菜单", exact: true }).click();
		};
		const switchTo = async (directory: string) => {
			await menu();
			await navigation.getByRole("combobox", { name: "工作区", exact: true }).click();
			await page.getByRole("option", { name: directory, exact: true }).click();
			await expect(navigation.locator(".workspace-select").first()).toContainText(path.basename(directory));
		};
		const runningRows = navigation.locator(".history-session-row").filter({
			has: page.locator('.activity-border[data-activity="running"]'),
		});
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await expect(editor).toBeVisible();
		await editor.fill("后台任务一");
		await editor.press("Control+Enter");
		await expect.poll(requests).toBe(1);
		const previousEditor = await editor.elementHandle();
		if (!previousEditor) throw new Error("缺少消息编辑器");
		await menu();
		await navigation.getByRole("button", { name: "新建会话", exact: true }).click();
		await expect.poll(() => previousEditor.evaluate((element) => element.isConnected)).toBe(false);
		await expect(editor).toBeVisible();
		await editor.fill("后台任务二");
		await editor.press("Control+Enter");
		await expect.poll(requests).toBe(2);
		await expect.poll(() => sessions.filter((session) => session.cwd === cwd).length).toBe(20);
		await menu();
		await expectSeparateRows(runningRows);
		await storeSession({ cwd, agentDir, provider: "gui-test", name: "历史-18", timestamp: 1018 });
		await expect.poll(() => sessions.filter((session) => session.cwd === cwd).length).toBe(21);
		await expect(navigation.locator(".history-virtual-row").first()).toBeVisible();
		await expect.poll(() => navigation.locator(".history-session-row").count()).toBeLessThan(21);
		const scroll = navigation.locator(".history-scroll [data-list-scroll]");
		await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
		await expect(navigation.getByRole("button", { name: "历史-0", exact: true })).toBeInViewport({ ratio: 0.5 });
		await scroll.evaluate((element) => { element.scrollTop = 0; });
		await expectSeparateRows(runningRows);
		for (let index = 0; index < 3; index++) {
			await switchTo(other);
			await expect.poll(() => sessions.some((session) => session.cwd === cwd)).toBe(false);
			await switchTo(cwd);
			await expect.poll(() => sessions.filter((session) => session.cwd === cwd).length).toBe(21);
			await menu();
			await expect(navigation.getByRole("button", { name: "历史-18", exact: true })).toBeVisible();
			await expectSeparateRows(runningRows);
			expect(requests()).toBe(2);
		}
		expect(errors).toEqual([]);
	} catch (error) {
		await info.attach("backend", { body: backend?.output ?? "", contentType: "text/plain" });
		throw error;
	} finally {
		response.resolve({ text: "已停止测试任务" });
		await context.close();
		await backend?.close();
		await model.close();
	}
});
