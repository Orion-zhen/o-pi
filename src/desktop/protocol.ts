import { net, protocol } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileResourceResponse } from "../gui/host/workspace/file-resource.ts";
import type { BackendClient } from "./backend-client.ts";

export const desktopEntryUrl = "opi://app/index.html";

export function installDesktopProtocol(directory: string, client: BackendClient): void {
	const root = path.join(directory, "ui");
	protocol.handle("opi", async (request) => {
		const url = new URL(request.url);
		if (url.hostname !== "app") return new Response("Forbidden", { status: 403 });
		if (url.pathname === "/api/file") {
			try {
				const token = url.searchParams.get("token");
				if (token === null) throw new Error("无效文件授权。");
				const resource = await client.request({ kind: "resource", token });
				return await fileResourceResponse(resource, request);
			} catch (error) {
				return new Response(error instanceof Error ? error.message : String(error), { status: 403 });
			}
		}
		const target = path.resolve(root, decodeURIComponent(url.pathname).slice(1));
		const relative = path.relative(root, target);
		if (relative.startsWith("..") || path.isAbsolute(relative)) return new Response("Forbidden", { status: 403 });
		const response = await net.fetch(pathToFileURL(target).href);
		const headers = new Headers(response.headers);
		headers.set(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
		);
		headers.set("X-Content-Type-Options", "nosniff");
		return new Response(response.body, { status: response.status, headers });
	});
}
