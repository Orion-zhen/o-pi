import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "../../../../helpers/fixture.ts";
import { startModelServer } from "../../../../../cli/model-server.ts";

let model: Awaited<ReturnType<typeof startModelServer>>;
const fixture = (name: string) => readFile(new URL(`../../../../../fixtures/heic/${name}.heic`, import.meta.url));

test.beforeEach(async ({ workspace: { agentDir, cwd } }) => {
	model = await startModelServer((request) => request.messages.some((message) => message.role === "tool")
		? { text: "HEIC verified" } : { tool: "read", args: { path: "photo.heic" } });
	await copyFile("tests/fixtures/heic/split.heic", path.join(cwd, "photo.heic"));
	await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProjectTrust: "never", defaultProvider: "heic-test", defaultModel: "test",
		compaction: { enabled: false }, retry: { enabled: false }, images: { autoResize: false },
	}));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "heic-test": {
		api: "openai-completions", baseUrl: model.url, apiKey: "fixture",
		models: [{ id: "test", input: ["text", "image"], contextWindow: 128000, maxTokens: 4096 }],
	} } }));
});
test.afterEach(async () => { await model.close(); });

test.describe("HEIC 附件与命令", () => {
	test.beforeEach(async ({ workspace: { agentDir } }) => {
		const directory = path.join(agentDir, "extensions");
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, "attachment-command.ts"), `export default (pi) => {
			pi.registerCommand("attachment-command", { description: "附件命令测试", handler: async (args, ctx) => ctx.ui.setEditorText(args) });
		};`);
	});

	test("多图附件阻止命令执行，移除后命令和输入历史保持原文", async ({ gui: { page } }) => {
		const editor = page.locator(".message-editor");
		const attach = async () => {
			await page.getByLabel("上传附件", { exact: true }).setInputFiles({ name: "multiple.heic", mimeType: "image/heic", buffer: await fixture("multiple") });
			await expect(page.getByRole("img", { name: "待发送图片", exact: true })).toHaveCount(1);
		};
		const rejectAttachment = async (text: string, button: string) => {
			await editor.fill(text);
			await page.getByRole("button", { name: button, exact: true }).click();
			await expect(page.getByRole("alert")).toContainText("命令不支持附件，请移除附件后再执行。");
			await expect(editor).toHaveValue(text);
			expect(model.requests).toHaveLength(requestCount);
			await page.getByRole("button", { name: "移除附件 1", exact: true }).click();
		};
		await editor.fill("初始化对话");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect(page.locator(".message.assistant").last()).toContainText("HEIC verified");
		const requestCount = model.requests.length;
		await attach();
		await rejectAttachment("/export jsonl", "发送");
		const download = page.waitForEvent("download", { timeout: 15_000 });
		await page.getByRole("button", { name: "发送", exact: true }).click();
		expect((await download).suggestedFilename()).toMatch(/\.jsonl$/);

		await attach();
		await rejectAttachment("!printf heic-shell", "执行命令");
		await page.getByRole("button", { name: "执行命令", exact: true }).click();
		await expect(page.locator(".message.bashExecution").last()).toContainText("heic-shell");
		await expect(page.locator(".message.bashExecution").last()).not.toContainText("primary only");
		await page.getByRole("button", { name: "输入历史", exact: true }).click();
		await page.getByRole("menuitem", { name: "!printf heic-shell", exact: true }).click();
		await expect(editor).toHaveValue("!printf heic-shell");

		await attach();
		await rejectAttachment("/attachment-command 原样参数", "发送");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect(editor).toHaveValue("原样参数");
		expect(model.requests).toHaveLength(requestCount);
	});
});

test("文件选择、粘贴和拖入 HEIC 均预览为 PNG，附件及 read 图片实际发送给模型", async ({ gui: { page } }) => {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const upload = page.getByLabel("上传附件", { exact: true });
	const send = page.getByRole("button", { name: "发送", exact: true });
	await editor.fill("读取 photo.heic 并比较附件");
	const gate = Promise.withResolvers<void>();
	await page.route(/\/assets\/heic-worker-.*\.js$/, async (route) => { await gate.promise; await route.continue(); });
	await upload.setInputFiles({ name: "PHOTO.HEIC", mimeType: "", buffer: await fixture("split") });
	await expect(page.getByRole("status").filter({ hasText: "正在处理附件" })).toBeVisible();
	await expect(send).toBeDisabled();
	gate.resolve();
	const previews = page.getByRole("img", { name: "待发送图片", exact: true });
	await expect(previews).toHaveCount(1);
	await page.unroute(/\/assets\/heic-worker-.*\.js$/);

	await editor.evaluate((element, bytes) => {
		const data = new DataTransfer();
		data.items.add(new File([new Uint8Array(bytes)], "renamed.bin", { type: "image/heic" }));
		element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
	}, [...await fixture("rotated")]);
	await expect(previews).toHaveCount(2);
	await page.locator(".composer-card").evaluate((element, bytes) => {
		const data = new DataTransfer();
		data.items.add(new File([new Uint8Array(bytes)], "multiple.heif", { type: "application/octet-stream" }));
		element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
	}, [...await fixture("multiple")]);
	await expect(previews).toHaveCount(3);
	await expect.poll(() => previews.evaluateAll((elements) => elements.map((element) => {
		const image = element as HTMLImageElement;
		return [image.naturalWidth, image.naturalHeight];
	}))).toEqual([[64, 32], [32, 64], [64, 32]]);
	for (const preview of await previews.all()) await expect(preview).toHaveAttribute("src", /^data:image\/png;base64,/);
	await send.click();
	await expect(page.locator(".message.assistant").last()).toContainText("HEIC verified");
	const payload = JSON.stringify(model.requests.at(-1)?.messages);
	expect(payload).toContain("[Image: primary only, 2 images total.]");
	expect(payload).not.toContain("data:image/heic");
	const urls = payload.match(/data:image\/png;base64,[^"\\]+/g);
	expect(urls).toHaveLength(4);
});

test("HEIC 解码失败保留草稿及已有附件，移除附件后不发送多图提示", async ({ gui: { page } }) => {
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	const upload = page.getByLabel("上传附件", { exact: true });
	await editor.fill("保留草稿");
	await upload.setInputFiles({ name: "photo.heic", mimeType: "image/heic", buffer: await fixture("multiple") });
	await expect(page.getByRole("img", { name: "待发送图片", exact: true })).toHaveCount(1);
	await upload.setInputFiles({ name: "broken.heic", mimeType: "image/heic", buffer: (await fixture("split")).subarray(0, 64) });
	await expect(page.getByRole("alert").filter({ hasText: "broken.heic" })).toBeVisible();
	await expect(editor).toHaveValue("保留草稿");
	await expect(page.getByRole("img", { name: "待发送图片", exact: true })).toHaveCount(1);
	await page.getByRole("button", { name: "移除附件 1", exact: true }).click();
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".message.assistant").last()).toContainText("HEIC verified");
	const request = model.requests.find((request) => Array.isArray(request.messages));
	const content = JSON.stringify(request?.messages.find((message) => message.role === "user")?.content);
	expect(content).toContain("保留草稿");
	expect(content).not.toContain("primary only");
});
