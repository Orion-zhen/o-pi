import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadImage } from "@napi-rs/canvas";
import { test, expect } from "./fixture.ts";
import { startModelServer } from "../cli/model-server.ts";

let model: Awaited<ReturnType<typeof startModelServer>>;
test.beforeEach(async ({ workspace: { cwd, agentDir } }) => {
	await copyFile("tests/harness/file-tools/fixtures/read/vector.pdf", path.join(cwd, "document.pdf"));
	model = await startModelServer((request) => request.messages.some((message) => message.role === "tool")
		? { text: "PDF 验证完成" }
		: { tool: "read", args: { path: "document.pdf", pages: "1" } });
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProjectTrust: "never", defaultProvider: "pdf-test", defaultModel: "test",
		compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "pdf-test": {
		api: "openai-completions", baseUrl: model.url, apiKey: "fixture",
		models: [{ id: "test", name: "test", input: ["text", "image"], contextWindow: 128000, maxTokens: 4096,
			inputLimits: { images: { resize: { maxWidth: 96, maxHeight: 96 } } },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
});
test.afterEach(async () => { await model?.close(); });

for (const mode of ["web", "desktop"] as const) test.describe(mode, () => {
	test.use({ mode });
	test.beforeEach(({}, info) => { test.skip(mode === "desktop" && info.project.name !== "desktop", "桌面应用使用桌面窗口"); });
	test("read PDF 将页面图片发送给模型", async ({ gui: { page } }) => {
		if (mode === "desktop") await expect(page.getByRole("treeitem", { name: "document.pdf", exact: true })).toBeVisible();
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.fill("读取 document.pdf");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect(page.locator(".reply-answer")).toContainText("PDF 验证完成");
		const result = model.requests.findLast((request) => Array.isArray(request.messages));
		expect(result).toBeDefined();
		const payload = JSON.stringify(result?.messages);
		expect(payload).not.toContain("<error>");
		const images = payload.match(/data:image\/png;base64,[^"\\]+/g);
		expect(images).toHaveLength(1);
		if (!images?.[0]) throw new Error("PDF image missing");
		const image = await loadImage(images[0]);
		expect(Math.max(image.width, image.height)).toBe(96);
	});
});
