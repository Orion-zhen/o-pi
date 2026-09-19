import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { GuiHost } from "../gui/host/host.ts";
import type { GuiClient } from "../gui/host/client.ts";
import { decodeGuiRequest } from "../gui/host/request.ts";

const MAX_BODY = 16 * 1024 * 1024;
const CSP =
	"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export async function startWebServer(
	gui: GuiHost,
	options: { host: string; port: number; assets: string; tls?: { cert: Buffer; key: Buffer } },
) {
	const clients = new Map<string, GuiClient>();
	const secure = options.tls !== undefined;
	const protocol = secure ? "https" : "http";
	function sameOrigin(request: IncomingMessage): boolean {
		return request.headers.origin === `${protocol}://${request.headers.host}`;
	}
	const handle = async (request: IncomingMessage, response: ServerResponse) => {
		response.setHeader("Content-Security-Policy", CSP);
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("Cache-Control", "no-store");
		const url = new URL(request.url ?? "/", `${protocol}://localhost`);
		try {
			if (url.pathname === "/health" && request.method === "GET") {
				response.end("ok");
				return;
			}
			if ((url.pathname === "/api/action" || url.pathname === "/api/query") && request.method === "POST") {
				if (!sameOrigin(request)) {
					response.writeHead(403).end("Forbidden");
					return;
				}
				if (request.headers["content-type"] !== "application/json") {
					response.writeHead(415).end("Expected application/json");
					return;
				}
				const body = await readBody(request);
				const id = request.headers["x-opi-client"];
				const client = typeof id === "string" ? clients.get(id) : undefined;
				if (!client) throw new Error("客户端连接已失效，请重连。");
				const { value, sessionId } = decodeGuiRequest(JSON.parse(body));
				if (url.pathname === "/api/query") {
					const result = await client.query(value, sessionId);
					response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(result));
				} else {
					await client.dispatch(value, sessionId);
					response.writeHead(204).end();
				}
				return;
			}
			if (url.pathname.startsWith("/api/")) {
				response.writeHead(404).end();
				return;
			}
			if (request.method !== "GET" && request.method !== "HEAD") {
				response.writeHead(405).end();
				return;
			}
			const relative =
				decodeURIComponent(url.pathname) === "/" ? "index.html" : decodeURIComponent(url.pathname).slice(1);
			const target = path.resolve(options.assets, relative);
			const check = path.relative(path.resolve(options.assets), target);
			if (check.startsWith("..") || path.isAbsolute(check)) {
				response.writeHead(403).end();
				return;
			}
			let data: Buffer;
			try {
				data = await readFile(target);
			} catch (error) {
				if (error instanceof Error && "code" in error && ["ENOENT", "EISDIR"].includes(String(error.code))) {
					response.writeHead(404).end();
					return;
				}
				throw error;
			}
			const types: Record<string, string> = {
				".html": "text/html; charset=utf-8",
				".js": "text/javascript",
				".css": "text/css",
				".svg": "image/svg+xml",
				".png": "image/png",
				".ico": "image/x-icon",
				".webmanifest": "application/manifest+json",
			};
			response.setHeader("Content-Type", types[path.extname(target)] ?? "application/octet-stream");
			response.end(request.method === "HEAD" ? undefined : data);
		} catch (error) {
			response
				.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
				.end(error instanceof Error ? error.message : String(error));
		}
	};
	const server = options.tls
		? createHttpsServer(options.tls, (req, res) => {
				void handle(req, res);
			})
		: createServer((req, res) => {
				void handle(req, res);
			});
	const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", `${protocol}://localhost`);
		if (url.pathname !== "/api/events" || !sameOrigin(request)) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		sockets.handleUpgrade(request, socket, head, (ws) => {
			const client = gui.createClient(url.searchParams.get("session") ?? undefined);
			clients.set(client.id, client);
			const connection = client.connect((delivery) => {
				if (ws.readyState !== ws.OPEN) return;
				if (ws.bufferedAmount > MAX_BODY) {
					ws.close(1013, "Client too slow");
					return;
				}
				ws.send(JSON.stringify(delivery));
			});
			client.emit({ type: "client", id: client.id });
			ws.on("message", (data) => {
				try {
					const value: unknown = JSON.parse(data.toString());
					if (typeof value !== "object" || value === null || !("ack" in value) || typeof value.ack !== "number" || !Number.isSafeInteger(value.ack))
						throw new Error("Invalid acknowledgement");
					connection.acknowledge(value.ack);
				} catch { ws.close(1008, "Expected acknowledgement"); }
			});
			ws.on("error", () => ws.terminate());
			ws.on("close", () => { connection.close(); client.close(); clients.delete(client.id); });
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("未能获取监听端口。");
	const hostname = options.host.includes(":") ? `[${options.host}]` : options.host;
	return {
		url: `${protocol}://${hostname}:${address.port}`,
		async close() {
			for (const socket of sockets.clients) socket.terminate();
			sockets.close();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const value of request) {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
		size += chunk.length;
		if (size > MAX_BODY) throw new Error("请求超过 16 MiB。");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}
