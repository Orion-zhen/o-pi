import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { test, expect } from "./desktop-fixture.ts";

test.beforeEach(async ({ workspace: { cwd } }) => {
	await writeFile(path.join(cwd, "pixel.png"), createCanvas(2, 2).toBuffer("image/png"));
	await copyFile("tests/harness/file-tools/fixtures/read/two-page.pdf", path.join(cwd, "document.pdf"));
});

test("桌面文件协议支持 Range，打包的 PDF worker 能加载", async ({ gui: { page } }) => {
	await page.getByRole("treeitem", { name: "pixel.png", exact: true }).click();
	const image = page.locator(".file-preview-image");
	await expect(page.locator(".media-details")).toContainText("2 × 2");
	const range = await image.evaluate(async (element) => {
		const response = await fetch((element as HTMLImageElement).src, { headers: { Range: "bytes=0-7" } });
		return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] };
	});
	expect(range).toEqual({ status: 206, bytes: [137, 80, 78, 71, 13, 10, 26, 10] });
	await page.getByRole("treeitem", { name: "document.pdf", exact: true }).click();
	await expect(page.getByLabel("第 1 页", { exact: true }).locator(".pdf-text-layer")).toContainText("Page one");
	expect(page.workers().some((worker) => worker.url().endsWith("/pdf/pdf.worker.mjs"))).toBe(true);
});

test("原生保存和外链通过限定桥接执行，渲染进程没有 Node 权限", async ({ gui: { app, page }, workspace: { cwd } }) => {
	const exported = path.join(cwd, "export.html");
	await app.evaluate(({ dialog, shell }, filePath) => {
		dialog.showSaveDialog = async () => ({ canceled: false, filePath });
		shell.openExternal = async (url) => { process.env.OPI_TEST_EXTERNAL_URL = url; };
	}, exported);
	const editor = page.getByRole("textbox", { name: "消息", exact: true });
	await editor.fill("!printf desktop-export");
	await editor.press("ControlOrMeta+Enter");
	await expect(page.locator(".message.bashExecution").last()).toContainText("desktop-export");
	await editor.fill("/export");
	await editor.press("ControlOrMeta+Enter");
	await expect(async () => expect(await readFile(exported, "utf8")).toContain("session-data")).toPass();
	await page.evaluate(async () => {
		if (!window.opi) throw new Error("缺少桌面连接");
		await window.opi.openExternal("https://example.com/oauth");
	});
	expect(await app.evaluate(() => process.env.OPI_TEST_EXTERNAL_URL)).toBe("https://example.com/oauth");
	expect(await page.evaluate(() => typeof (globalThis as Record<string, unknown>)["require"])).toBe("undefined");
});
