import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect } from "./desktop-fixture.ts";
import { startModelServer } from "../cli/model-server.ts";

let model: Awaited<ReturnType<typeof startModelServer>>;

test.beforeEach(async ({ workspace: { cwd, agentDir } }) => {
	model = await startModelServer((request) => request.messages.some((message) => message.role === "tool")
		? { text: "已读取 PDF 的两页内容" }
		: { tool: "read", args: { path: "document.pdf" } });
	await copyFile("tests/harness/file-tools/fixtures/read/two-page.pdf", path.join(cwd, "document.pdf"));
	await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProjectTrust: "never", defaultProvider: "pdf-test", defaultModel: "test",
		compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "pdf-test": {
		api: "openai-completions", baseUrl: model.url, apiKey: "fixture",
		models: [{ id: "test", name: "PDF Test", reasoning: false, input: ["text", "image"],
			contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
});
test.afterEach(async () => { await model?.close(); });

test("桌面模型调用 read 读取 PDF，收到两页图片后完成回复", async ({ gui: { page } }) => {
	await page.getByRole("textbox", { name: "消息", exact: true }).fill("读取 document.pdf 的全部内容");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".reply-answer")).toContainText("已读取 PDF 的两页内容");

	expect(model.requests).toHaveLength(2);
	const messages = model.requests.at(-1)?.messages;
	expect(messages?.find((message) => message.role === "tool")?.content).toContain('pages="1-2/2"');
	const images = messages?.flatMap((message): unknown[] => Array.isArray(message.content) ? message.content : [])
		.filter((part) => typeof part === "object" && part !== null && "type" in part && part.type === "image_url");
	const pageImage = expect.objectContaining({
		type: "image_url", image_url: expect.objectContaining({ url: expect.stringMatching(/^data:image\/(png|jpeg);base64,.+/) }),
	});
	expect(images).toEqual([pageImage, pageImage]);
});
