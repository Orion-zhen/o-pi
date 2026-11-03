import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { contentHash } from "../../../src/harness/filesystem/services/text.ts";
import { createInlineImageProcessor } from "../../../src/harness/file-tools/pi/ports/read-image.ts";
import { createCrudTestContext } from "./crud-fixtures.ts";

const context = createCrudTestContext();
const fixture = (name: string) => readFile(new URL(`../../fixtures/heic/${name}.heic`, import.meta.url));

describe("read HEIC", () => {
	it.each(["split", "multiple", "rotated"])("读取 %s 的主图，保留原文件和原始元数据", async (name) => {
		const original = await fixture(name);
		// 类型识别依据文件内容，不依赖扩展名。
		const file = path.join(context.workspace, "photo.bin");
		await writeFile(file, original);
		const result = await context.read({ path: "photo.bin" });
		expect(result).toMatchObject({
			media_type: "image", mime_type: "image/heic", size_bytes: original.length,
			version: contentHash(original), image: { mime_type: "image/png" },
		});
		if (!("image" in result)) throw new Error("缺少转换图片");
		const image = await loadImage(Buffer.from(result.image.data, "base64"));
		expect([image.width, image.height]).toEqual(name === "rotated" ? [32, 64] : [64, 32]);
		const canvas = createCanvas(image.width, image.height);
		const pixels = canvas.getContext("2d");
		pixels.drawImage(image, 0, 0);
		expect(pixels.getImageData(8, 8, 1, 1).data[0]).toBeGreaterThan(240);
		expect(pixels.getImageData(8, 8, 1, 1).data[3]).toBe(255);
		const green = name === "rotated" ? pixels.getImageData(8, 48, 1, 1) : pixels.getImageData(48, 8, 1, 1);
		expect(green.data[1]).toBeGreaterThan(240);
		expect(result.hints).toEqual(name === "multiple" ? ["[Image: primary only, 2 images total.]"] : undefined);
		expect(await readFile(file)).toEqual(original);
	});

	it("取消正在转换的图片后，后续转换仍正常完成", async () => {
		const bytes = await fixture("split");
		const processor = createInlineImageProcessor();
		const controller = new AbortController();
		const pending = processor.process({ bytes, mimeType: "image/heic", path: "photo.heic", signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
		expect(await processor.process({ bytes, mimeType: "image/heic", path: "photo.heic" })).toMatchObject({
			ok: true, value: { mimeType: "image/png" },
		});
	});

	it("损坏的 HEIC 返回转换失败，不按文本或其他格式重试", async () => {
		await writeFile(path.join(context.workspace, "broken.heic"), (await fixture("split")).subarray(0, 64));
		expect(await context.read({ path: "broken.heic" })).toMatchObject({
			status: "failed", error: { code: "BINARY_FILE_UNSUPPORTED" },
		});
	});
});
