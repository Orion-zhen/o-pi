import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import { workspacePath } from "./workspace-path.ts";

export interface FileResource {
	cwd: string;
	path: string;
	version: string;
	mime: string;
	size: number;
}

export function fileVersion(stat: BigIntStats): string {
	return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join("-");
}

/** 每个客户端独立签名，刷新同一版本时地址不变，不保留文件或授权缓存。 */
export class FileResources {
	private readonly key = randomBytes(32);
	constructor(private readonly clientId: string) {}
	url(resource: FileResource): string {
		const payload = Buffer.from(JSON.stringify(resource)).toString("base64url");
		const signature = createHmac("sha256", this.key).update(payload).digest("base64url");
		return `/api/file?client=${this.clientId}&token=${payload}.${signature}`;
	}
	resolve(token: string, cwd: string): FileResource {
		const [payload, signature, extra] = token.split(".");
		if (!payload || !signature || extra !== undefined) throw new Error("无效文件授权。");
		const expected = createHmac("sha256", this.key).update(payload).digest();
		const actual = Buffer.from(signature, "base64url");
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("无效文件授权。");
		// 签名验证后仅解析本进程生成的描述，不接受调用方自行声明的路径或类型。
		const resource = JSON.parse(Buffer.from(payload, "base64url").toString()) as FileResource;
		if (resource.cwd !== cwd) throw new Error("工作区已切换，请刷新后重试。");
		return resource;
	}
}

function byteRange(value: string, size: number): [number, number] | undefined {
	const match = /^bytes=(\d*)-(\d*)$/.exec(value);
	if (!match || (!match[1] && !match[2])) return;
	const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
	const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return;
	return [start, end];
}

/** Web 和 Electron 共用有背压的读取，每个分段均核验同一文件版本。 */
export async function fileResourceResponse(resource: FileResource, request: Request): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
	request.signal.throwIfAborted();
	const file = await workspacePath(resource.cwd, resource.path);
	const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	let closing: Promise<void> | undefined;
	const close = () => closing ??= handle.close();
	try {
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile() || fileVersion(stat) !== resource.version) {
			await close();
			return new Response("文件已变化，请刷新预览。", { status: 409 });
		}
		const headers = new Headers({
			"Content-Type": resource.mime, "Accept-Ranges": "bytes", "Cache-Control": "no-store",
			"ETag": `"${resource.version}"`, "X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-origin",
		});
		const rangeHeader = request.headers.get("range");
		const range = rangeHeader === null ? undefined : byteRange(rangeHeader, resource.size);
		if (rangeHeader !== null && !range) {
			await close();
			headers.set("Content-Range", `bytes */${resource.size}`);
			return new Response(null, { status: 416, headers });
		}
		let position = range?.[0] ?? 0;
		const end = range?.[1] ?? resource.size - 1;
		headers.set("Content-Length", String(end - position + 1));
		if (range) headers.set("Content-Range", `bytes ${position}-${end}/${resource.size}`);
		const status = range ? 206 : 200;
		if (request.method === "HEAD") { await close(); return new Response(null, { status, headers }); }
		let abort: () => void;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				abort = () => { controller.error(request.signal.reason); void close(); };
				request.signal.addEventListener("abort", abort, { once: true });
				if (request.signal.aborted) abort();
			},
			async pull(controller) {
				try {
					request.signal.throwIfAborted();
					const buffer = new Uint8Array(Math.min(64 * 1024, end - position + 1));
					const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
					if (!bytesRead || fileVersion(await handle.stat({ bigint: true })) !== resource.version)
						throw new Error("文件在读取期间发生变化，请刷新预览。");
					position += bytesRead;
					if (closing) return;
					controller.enqueue(buffer.subarray(0, bytesRead));
					if (position > end) {
						request.signal.removeEventListener("abort", abort);
						await close(); controller.close();
					}
				} catch (error) {
					request.signal.removeEventListener("abort", abort);
					if (!closing) controller.error(error);
					await close();
				}
			},
			async cancel() { request.signal.removeEventListener("abort", abort); await close(); },
		});
		return new Response(body, { status, headers });
	} catch (error) { await close(); throw error; }
}
