import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../../../helpers/fixture.ts";

async function openFile(page: Page, name: string, phone: boolean) {
	const navigation = page.locator(phone ? ".mobile-sidebar" : ".sidebar");
	if (phone) {
		await page.getByRole("button", { name: "菜单", exact: true }).click();
		await navigation.locator(".workbench-pane-tabs").getByRole("button", { name: "文件", exact: true }).click();
	}
	await navigation.getByRole("button", { name: "刷新文件", exact: true }).click();
	await navigation.getByRole("treeitem", { name, exact: true }).click();
}

test("HEIC 原始像素预览默认主图，可查看全部图片并沿用缩放和拖动", async ({ gui: { page }, workspace: { cwd } }, info) => {
	await copyFile("tests/fixtures/heic/multiple.heic", path.join(cwd, "多图.bin"));
	await writeFile(path.join(cwd, "plain.txt"), "plain file");
	await openFile(page, "多图.bin", info.project.name === "phone");
	const canvas = page.locator("canvas.file-preview-image");
	const number = page.getByRole("spinbutton", { name: "图片序号", exact: true });
	const previous = page.getByRole("button", { name: "上一张图片", exact: true });
	const next = page.getByRole("button", { name: "下一张图片", exact: true });
	const zoom = page.getByRole("textbox", { name: "图片缩放比例", exact: true });
	await expect(number).toHaveValue("2");
	await expect(page.getByLabel("图片总数", { exact: true })).toHaveText("/ 2");
	await expect(page.locator(".media-details")).toContainText("64 × 32");
	await expect(next).toBeDisabled();
	await expect(previous).toBeEnabled();
	await expect(page.getByText("主图", { exact: true })).toBeVisible();
	await expect(canvas).toHaveAttribute("width", "64");
	await zoom.fill("3200");
	await zoom.press("Enter");
	await expect(canvas).toHaveCSS("width", "2048px");
	const viewport = await page.getByLabel("图片正文", { exact: true }).boundingBox();
	if (!viewport) throw new Error("缺少图片视口");
	const before = await canvas.evaluate((element) => element.style.transform);
	await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
	await page.mouse.down();
	await page.mouse.move(viewport.x + viewport.width / 2 + 25, viewport.y + viewport.height / 2 + 20);
	await page.mouse.up();
	expect(await canvas.evaluate((element) => element.style.transform)).not.toBe(before);
	await previous.click();
	await expect(number).toHaveValue("1");
	await expect(previous).toBeDisabled();
	await expect(next).toBeEnabled();
	await expect(page.locator(".media-details")).toContainText("16 × 16");
	await expect(zoom).toHaveValue("3200");
	await expect(page.getByText("主图", { exact: true })).toHaveCount(0);
	expect(await canvas.evaluate((element) => {
		const context = (element as HTMLCanvasElement).getContext("2d");
		if (!context) throw new Error("缺少画布");
		return context.getImageData(8, 8, 1, 1).data[2];
	})).toBeGreaterThan(240);
	await number.fill("2");
	await number.press("Enter");
	await expect(page.locator(".media-details")).toContainText("64 × 32");
	await page.getByRole("button", { name: "适应窗口", exact: true }).click();
	await expect(canvas).toHaveCSS("width", "64px");
	await openFile(page, "plain.txt", info.project.name === "phone");
	await expect.poll(() => page.workers().filter((worker) => worker.url().includes("heic-preview-worker")).length).toBe(0);
	await expect(page.getByLabel("文件内容")).toContainText("plain file");
});

test("HEIC 旋转正常，文件更新会重新读取，损坏文件可重试", async ({ gui: { page }, workspace: { cwd } }, info) => {
	const filename = path.join(cwd, "photo.heic");
	await copyFile("tests/fixtures/heic/rotated.heic", filename);
	await openFile(page, "photo.heic", info.project.name === "phone");
	const canvas = page.locator("canvas.file-preview-image");
	await expect(page.locator(".media-details")).toContainText("32 × 64");
	await expect(page.getByRole("spinbutton", { name: "图片序号", exact: true })).toHaveCount(0);
	await expect(canvas).toHaveAttribute("width", "32");
	await expect(canvas).toHaveAttribute("height", "64");
	await copyFile("tests/fixtures/heic/split.heic", filename);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(page.locator(".media-details")).toContainText("64 × 32");
	const bytes = await readFile(filename);
	await writeFile(filename, bytes.subarray(0, 64));
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(page.getByRole("alert")).toContainText("HEIC 读取失败");
	const request = page.waitForRequest((request) => request.url().includes("/api/file?"));
	await page.getByRole("button", { name: "重试 HEIC", exact: true }).click();
	await request;
	await expect(page.getByRole("alert")).toContainText("HEIC 读取失败");
	await expect.poll(() => page.workers().filter((worker) => worker.url().includes("heic-preview-worker")).length).toBe(0);
});
