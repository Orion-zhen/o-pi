import { copyFile, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FileResources, fileResourceResponse, type FileResource } from "../../src/gui/host/file-resource.ts";
import { previewWorkspaceFile } from "../../src/gui/host/workspace-files.ts";
import { useTempDir } from "../helpers/lifecycle.ts";

const temp = useTempDir("opi-file-resource-");
let cwd: string;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=", "base64");
const request = (range?: string, method = "GET") => new Request("http://localhost/api/file", { method, ...(range ? { headers: { Range: range } } : {}) });
async function resource(name: string): Promise<FileResource> {
	const preview = await previewWorkspaceFile(cwd, name, new AbortController().signal);
	const content = preview.content;
	if (content.kind !== "image" && content.kind !== "pdf") throw new Error("预期媒体文件");
	return { cwd, path: name, mime: content.mime, size: content.size, version: content.version };
}

beforeEach(async () => { cwd = path.join(temp.path, "workspace"); await mkdir(cwd); });

describe("文件预览资源", () => {
	it.each(["image", "pdf"])("%s 不按字节大小拒绝预览，只读取所需区间", async (kind) => {
		const name = kind === "pdf" ? "large.pdf" : "large.png";
		const file = path.join(cwd, name);
		if (kind === "pdf") await copyFile("tests/harness/file-tools/fixtures/read/two-page.pdf", file);
		else await writeFile(file, png);
		const size = 5 * 1024 ** 3;
		await truncate(file, size);
		const value = await resource(name);
		expect(value.size).toBe(size);
		const head = await fileResourceResponse(value, request(undefined, "HEAD"));
		expect(head.headers.get("Content-Length")).toBe(String(size));
		expect(head.body).toBeNull();
		const tail = await fileResourceResponse(value, request(`bytes=${size - 8}-`));
		expect(tail.status).toBe(206);
		expect(tail.headers.get("Content-Range")).toBe(`bytes ${size - 8}-${size - 1}/${size}`);
		expect(new Uint8Array(await tail.arrayBuffer())).toEqual(new Uint8Array(8));
	});

	it("识别真实类型、隔离 SVG，保留文本上限", async () => {
		await writeFile(path.join(cwd, "image.txt"), png);
		expect((await resource("image.txt")).mime).toBe("image/png");
		await writeFile(path.join(cwd, "vector.svg"), '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
		const response = await fileResourceResponse(await resource("vector.svg"), request());
		expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
		expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
		await response.body?.cancel();
		await writeFile(path.join(cwd, "large.txt"), "x".repeat(512 * 1024 + 1));
		expect((await previewWorkspaceFile(cwd, "large.txt", new AbortController().signal)).content.kind).toBe("unavailable");
	});

	it("支持整文件、前缀、后缀和开放区间，拒绝无效或多区间请求", async () => {
		await writeFile(path.join(cwd, "image.png"), png);
		const value = await resource("image.png");
		const full = await fileResourceResponse(value, request());
		expect(full.status).toBe(200);
		expect(Buffer.from(await full.arrayBuffer())).toEqual(png);
		for (const [range, expected] of [["bytes=0-7", png.subarray(0, 8)], ["bytes=-8", png.subarray(-8)], ["bytes=8-", png.subarray(8)]] as const) {
			const part = await fileResourceResponse(value, request(range));
			expect(part.status).toBe(206);
			expect(Buffer.from(await part.arrayBuffer())).toEqual(expected);
		}
		for (const range of ["bytes=9999-", "bytes=4-2", "bytes=-0", "bytes=0-1,4-5", "bytes=-", "invalid"]) {
			const invalid = await fileResourceResponse(value, request(range));
			expect(invalid.status).toBe(416);
			expect(invalid.headers.get("Content-Range")).toBe(`bytes */${png.length}`);
		}
	});

	it("授权绑定客户端和工作区，同一版本 URL 稳定且不能篡改", async () => {
		await writeFile(path.join(cwd, "image.png"), png);
		const value = await resource("image.png");
		const owner = new FileResources("owner");
		const url = owner.url(value);
		expect(owner.url(value)).toBe(url);
		const token = new URL(url, "http://localhost").searchParams.get("token") ?? "";
		expect(owner.resolve(token, cwd)).toEqual(value);
		expect(() => owner.resolve(token, path.dirname(cwd))).toThrow("工作区已切换");
		expect(() => new FileResources("other").resolve(token, cwd)).toThrow("无效文件授权");
		expect(() => owner.resolve(`x${token}`, cwd)).toThrow("无效文件授权");
	});

	it("授权后文件被替换或改为外部符号链接时不读取旧版本", async () => {
		await writeFile(path.join(cwd, "image.png"), png);
		const value = await resource("image.png");
		await writeFile(path.join(cwd, "image.png"), Buffer.concat([png, Buffer.from("changed")]));
		expect((await fileResourceResponse(value, request())).status).toBe(409);
		await writeFile(path.join(temp.path, "outside.png"), png);
		await rm(path.join(cwd, "image.png"));
		await symlink(path.join(temp.path, "outside.png"), path.join(cwd, "image.png"));
		await expect(fileResourceResponse(value, request())).rejects.toThrow("超出");
	});

	it("读取中修改和主动取消会终止流", async () => {
		const file = path.join(cwd, "image.png");
		await writeFile(file, png);
		await truncate(file, 1024 * 1024);
		let value = await resource("image.png");
		const response = await fileResourceResponse(value, request());
		const reader = response.body?.getReader();
		if (!reader) throw new Error("缺少流");
		await reader.read();
		await truncate(file, 32);
		await expect(async () => { while (!(await reader.read()).done) { /* 排空已缓冲的分段。 */ } }).rejects.toThrow("变化");
		await writeFile(file, png);
		value = await resource("image.png");
		const controller = new AbortController();
		const pending = await fileResourceResponse(value, new Request("http://localhost/api/file", { signal: controller.signal }));
		controller.abort();
		await expect(pending.arrayBuffer()).rejects.toThrow();
	});
});
