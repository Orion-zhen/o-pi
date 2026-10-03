import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomFillSync } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixture.ts";

function manyPages(count: number): Buffer {
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
	for (let i = 0; i < count; i++) {
		const content = `BT /F1 24 Tf 30 350 Td (Page ${i + 1}) Tj ET\n%${" padding".repeat(2500)}\n`;
		objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${i % 2 ? 400 : 300} 400] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`, `<< /Length ${content.length} >>\nstream\n${content}endstream`);
	}
	let output = "%PDF-1.7\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) { offsets.push(output.length); output += `${index + 1} 0 obj\n${object}\nendobj\n`; }
	const xref = output.length;
	output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(output);
}

async function openFile(page: Page, name: string, phone: boolean) {
	const navigation = page.locator(phone ? ".mobile-sidebar" : ".sidebar");
	if (phone) {
		await page.getByRole("button", { name: "菜单", exact: true }).click();
		await navigation.locator(".workbench-pane-tabs").getByRole("button", { name: "文件", exact: true }).click();
	}
	await navigation.getByRole("button", { name: "刷新文件", exact: true }).click();
	await navigation.getByRole("treeitem", { name, exact: true }).click();
}

test.describe("媒体预览", () => {

	test("图片支持缩放输入、指针缩放和拖动，刷新保留阅读状态", async ({ gui: { page }, workspace: { cwd } }, info) => {
		const canvas = createCanvas(1200, 900);
		const context = canvas.getContext("2d");
		const pixels = context.createImageData(1200, 900);
		randomFillSync(pixels.data);
		context.putImageData(pixels, 0, 0);
		await writeFile(path.join(cwd, "大图.png"), await canvas.encode("png"));
		await openFile(page, "大图.png", info.project.name === "phone");
		const image = page.locator(".file-preview-image");
		const zoom = page.getByRole("textbox", { name: "图片缩放比例", exact: true });
		const fit = page.getByRole("button", { name: "适应窗口", exact: true });
		await expect(page.locator(".media-details")).toContainText("1200 × 900");
		const fitWidth = await image.evaluate((element) => element.style.width);
		await zoom.focus();
		await zoom.press("Tab");
		await expect(fit).toHaveAttribute("aria-pressed", "true");
		expect(await image.evaluate((element) => element.style.width)).toBe(fitWidth);
		await zoom.fill("125.5%");
		expect(await image.evaluate((element) => element.style.width)).toBe(fitWidth);
		await zoom.press("Enter");
		await expect(zoom).toHaveValue("125.5");
		await expect(image).toHaveCSS("width", "1506px");
		await expect(fit).toHaveAttribute("aria-pressed", "false");
		await zoom.fill("200");
		await zoom.press("Escape");
		await zoom.press("Tab");
		await expect(zoom).toHaveValue("125.5");
		for (const value of ["", "abc", "0", "-10", "Infinity"]) {
			await zoom.fill(value);
			await zoom.press("Enter");
			await expect(zoom).toHaveValue("125.5");
		}
		for (const [value, higher, lower] of [["132.99", "135", "130"], ["115", "120", "110"]] as const) {
			await zoom.fill(value);
			await zoom.press("Enter");
			await page.getByRole("button", { name: "放大图片", exact: true }).click();
			await expect(zoom).toHaveValue(higher);
			await zoom.fill(value);
			await zoom.press("Enter");
			await page.getByRole("button", { name: "缩小图片", exact: true }).click();
			await expect(zoom).toHaveValue(lower);
		}
		await page.getByLabel("图片正文", { exact: true }).press("+");
		await expect(zoom).toHaveValue("115");
		await page.getByLabel("图片正文", { exact: true }).press("-");
		await expect(zoom).toHaveValue("110");
		for (const [value, expected, width] of [["9999", "3200", "38400px"], ["0.1", "1", "12px"]] as const) {
			await zoom.fill(value);
			await zoom.press("Tab");
			await expect(zoom).toHaveValue(expected);
			await expect(image).toHaveCSS("width", width);
		}
		const actual = page.getByRole("button", { name: "实际大小", exact: true });
		await expect(actual).toHaveText("1:1");
		await actual.click();
		await expect(zoom).toHaveValue("100");
		const viewport = await page.getByLabel("图片正文", { exact: true }).boundingBox();
		const before = await image.boundingBox();
		if (!viewport || !before) throw new Error("缺少图片视口");
		const anchor = { x: Math.round(viewport.x + viewport.width * 0.65), y: Math.round(viewport.y + viewport.height * 0.6) };
		await page.mouse.move(anchor.x, anchor.y);
		await page.mouse.wheel(0, -10);
		await expect(zoom).toHaveValue("105");
		const after = await image.boundingBox();
		if (!after) throw new Error("缺少缩放后的图片边界");
		expect(after.width).toBeCloseTo(before.width * 1.05, 1);
		expect(after.x + (anchor.x - before.x) * 1.05).toBeCloseTo(anchor.x, 1);
		expect(after.y + (anchor.y - before.y) * 1.05).toBeCloseTo(anchor.y, 1);
		await page.mouse.wheel(0, 1000);
		await expect(zoom).toHaveValue("100");
		const transform = await image.evaluate((element) => element.style.transform);
		await page.mouse.down();
		await page.mouse.move(anchor.x + 30, anchor.y + 20);
		await page.mouse.up();
		expect(await image.evaluate((element) => element.style.transform)).not.toBe(transform);
		const imageUrl = await image.getAttribute("src");
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect(image).toHaveAttribute("src", imageUrl ?? "");
		await expect(zoom).toHaveValue("100");
		expect(await image.evaluate((element) => element.style.transform)).not.toBe(transform);
		await fit.click();
		await expect(fit).toHaveAttribute("aria-pressed", "true");
		await expect(image).toHaveCSS("width", fitWidth);
		await expect(page.getByRole("button", { name: "自动折行", exact: true })).toHaveCount(0);
		await expect(page.locator(".message.user")).toHaveCount(0);
	});

	test("SVG 隔离加载且小图不放大，图片读取失败可重试", async ({ gui: { page }, workspace: { cwd } }, info) => {
		await writeFile(path.join(cwd, "vector.svg"), '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="red"/><script>throw new Error("SVG script ran")</script><image href="https://svg-invalid.example/image.png"/></svg>');
		await writeFile(path.join(cwd, "broken.gif"), Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32)]));
		const external: string[] = [];
		page.on("request", (request) => { if (request.url().includes("svg-invalid")) external.push(request.url()); });
		await openFile(page, "vector.svg", info.project.name === "phone");
		await expect(page.locator(".media-details")).toContainText("80 × 40");
		await expect(page.getByRole("button", { name: "适应窗口", exact: true })).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByRole("textbox", { name: "图片缩放比例", exact: true })).toHaveValue("100");
		expect(external).toEqual([]);
		await openFile(page, "broken.gif", info.project.name === "phone");
		await expect(page.getByRole("alert")).toContainText("图片无法解码");
		const retry = page.waitForRequest((request) => request.url().includes("/api/file?"));
		await page.getByRole("button", { name: "重试图片", exact: true }).click();
		await retry;
		await expect(page.getByRole("alert")).toContainText("图片无法解码");
	});

	test("PDF 支持缩放、翻页和文字选择，切换文件释放阅读器", async ({ gui: { page }, workspace: { cwd } }, info) => {
		await copyFile("tests/harness/file-tools/fixtures/read/two-page.pdf", path.join(cwd, "two.pdf"));
		await writeFile(path.join(cwd, "plain.txt"), "plain file\n");
		await openFile(page, "two.pdf", info.project.name === "phone");
		await expect(page.getByLabel("PDF 总页数", { exact: true })).toHaveText("/ 2");
		const first = page.getByLabel("第 1 页", { exact: true });
		await expect(first.locator(".pdf-text-layer")).toContainText("Page one");
		await expect(first.getByRole("status")).toHaveCount(0);
		expect(page.workers().some((worker) => worker.url().endsWith("/pdf/pdf.worker.mjs"))).toBe(true);
		await first.locator(".pdf-text-layer span").first().dblclick({ position: { x: 5, y: 5 } });
		expect(await page.evaluate(() => window.getSelection()?.toString())).toContain("Page");
		const zoom = page.getByRole("textbox", { name: "PDF 缩放比例", exact: true });
		await zoom.fill("100");
		await zoom.press("Enter");
		await expect(zoom).toHaveValue("100");
		const width = await first.evaluate((element) => element.getBoundingClientRect().width);
		await zoom.fill("150%");
		await zoom.press("Tab");
		await expect(first).toHaveCSS("width", `${width * 1.5}px`);
		await page.getByRole("button", { name: "放大 PDF", exact: true }).click();
		await expect(zoom).toHaveValue("155");
		await page.getByRole("button", { name: "缩小 PDF", exact: true }).click();
		await expect(zoom).toHaveValue("150");
		for (const [value, expected] of [["9999", "800"], ["1", "10"]] as const) {
			await zoom.fill(value);
			await zoom.press("Enter");
			await expect(zoom).toHaveValue(expected);
		}
		const fit = page.getByRole("button", { name: "适应宽度", exact: true });
		await fit.click();
		await zoom.focus();
		await zoom.press("Tab");
		await expect(fit).toHaveAttribute("aria-pressed", "true");
		await page.getByRole("button", { name: "适应整页", exact: true }).click();
		const number = page.getByRole("spinbutton", { name: "PDF 页码", exact: true });
		await number.fill("1");
		await number.press("Enter");
		await page.getByRole("button", { name: "下一页", exact: true }).click();
		await expect(number).toHaveValue("2");
		await expect(page.getByLabel("第 2 页", { exact: true }).locator(".pdf-text-layer")).toContainText("Page");
		await expect(page.getByRole("alert")).toHaveCount(0);
		await openFile(page, "plain.txt", info.project.name === "phone");
		await expect(page.getByLabel("文件正文", { exact: true })).toContainText("plain file");
		await expect(page.locator(".pdf-page")).toHaveCount(0);
		await expect.poll(() => page.workers().filter((worker) => worker.url().endsWith("/pdf/pdf.worker.mjs")).length).toBe(0);
		await expect(page.locator(".message.user")).toHaveCount(0);
	});

	test("长 PDF 按需阅读，滚轮缩放不影响浏览器，更新后保留缩放并限制页码", async ({ gui: { page }, workspace: { cwd } }, info) => {
		await writeFile(path.join(cwd, "many.pdf"), manyPages(40));
		await openFile(page, "many.pdf", info.project.name === "phone");
		await expect(page.getByLabel("PDF 总页数", { exact: true })).toHaveText("/ 40");
		const zoom = page.getByRole("textbox", { name: "PDF 缩放比例", exact: true });
		const viewport = page.getByLabel("PDF 正文", { exact: true });
		const pixelRatio = await page.evaluate(() => window.devicePixelRatio);
		for (const modifier of ["Control", "Meta"]) {
			await zoom.fill("132.99");
			await zoom.press("Enter");
			await viewport.hover();
			await page.keyboard.down(modifier);
			try {
				await page.mouse.wheel(0, -100);
				await expect(zoom).toHaveValue("135");
				await page.mouse.wheel(0, 100);
				await expect(zoom).toHaveValue("130");
			} finally { await page.keyboard.up(modifier); }
		}
		expect(await page.evaluate(() => window.devicePixelRatio)).toBe(pixelRatio);
		const scrollTop = await viewport.evaluate((element) => element.scrollTop);
		await page.mouse.wheel(0, 300);
		await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollTop);
		await expect(zoom).toHaveValue("130");
		const number = page.getByRole("spinbutton", { name: "PDF 页码", exact: true });
		await number.fill("30");
		await number.press("Enter");
		await expect(number).toHaveValue("30");
		await expect(page.getByLabel("第 30 页", { exact: true }).locator(".pdf-text-layer")).toContainText("Page 30");
		expect(await page.locator(".pdf-page").count()).toBeLessThan(8);
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect(number).toHaveValue("30");
		await writeFile(path.join(cwd, "many.pdf"), manyPages(4));
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await expect(page.getByLabel("PDF 总页数", { exact: true })).toHaveText("/ 4");
		await expect(number).toHaveValue("4");
		await expect(zoom).toHaveValue("130");
		await expect(page.getByLabel("第 4 页", { exact: true }).locator(".pdf-text-layer")).toContainText("Page 4");
		await expect(page.getByRole("alert")).toHaveCount(0);
	});

	test("加密和损坏的 PDF 显示读取错误", async ({ gui: { page }, workspace: { cwd } }, info) => {
		await copyFile("tests/harness/file-tools/fixtures/read/password.pdf", path.join(cwd, "password.pdf"));
		await writeFile(path.join(cwd, "broken.pdf"), "%PDF-1.7\nnot a document\n");
		await openFile(page, "password.pdf", info.project.name === "phone");
		await expect(page.getByRole("alert")).toContainText("需要密码");
		await openFile(page, "broken.pdf", info.project.name === "phone");
		await expect(page.getByRole("alert")).toContainText("PDF 读取失败");
	});
});
