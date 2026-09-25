import { createServer, request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { WebSocketServer } from "ws";

export async function startProxyFixture(modelUrl: string) {
	const sockets = new Set<Socket>();
	const track = (socket: Socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
	const websocket = createServer();
	websocket.on("connection", track);
	const wss = new WebSocketServer({ server: websocket });
	const socketHeaders: Array<string | undefined> = [];
	wss.on("connection", (socket, request) => {
		socketHeaders.push(request.headers.authorization);
		socket.on("message", (data, binary) => socket.send(data, { binary }));
	});
	const wsPort = await listen(websocket);
	let systemPages = 0;
	let explicitPages = 0;
	const proxy = createServer((request, response) => {
		const target = new URL(request.url ?? "/", "http://proxy");
		if (target.hostname === "8.8.8.8") {
			systemPages++;
			response.writeHead(200, { "content-type": "text/plain" }).end("system-web " + "网页正文。".repeat(100));
			return;
		}
		const forwarded = httpRequest(new URL(target.pathname + target.search, modelUrl), {
			method: request.method, headers: request.headers, agent: false,
		}, (result) => { response.writeHead(result.statusCode ?? 500, result.headers); result.pipe(response); });
		request.pipe(forwarded);
		response.once("close", () => forwarded.destroy());
		forwarded.on("error", () => response.destroy());
	});
	proxy.on("connection", track);
	proxy.on("connect", (_request, socket, head) => {
		const upstream = connect(wsPort, "127.0.0.1", () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			socket.pipe(upstream).pipe(socket);
		});
		track(upstream);
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
		socket.on("close", () => upstream.destroy());
	});
	const proxyPort = await listen(proxy);
	const explicit = createServer((_request, response) => {
		explicitPages++;
		response.writeHead(200, { "content-type": "text/plain" }).end("explicit-web " + "工具代理正文。".repeat(100));
	});
	explicit.on("connection", track);
	const explicitPort = await listen(explicit);
	return {
		url: `http://127.0.0.1:${proxyPort}`,
		explicitUrl: `http://127.0.0.1:${explicitPort}`,
		wsUrl: `ws://127.0.0.1:${wsPort}`,
		socketHeaders,
		get systemPages() { return systemPages; },
		get explicitPages() { return explicitPages; },
		async close() {
			for (const client of wss.clients) client.terminate();
			wss.close();
			for (const socket of sockets) socket.destroy();
			await Promise.all([proxy, explicit, websocket].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
		},
	};
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test server address");
	return address.port;
}

export function socketToolExtension(url: string): string {
	return `export default function (pi) {
		pi.registerTool({ name: "proxy_socket", label: "Proxy socket", description: "Check WebSocket transport",
			parameters: { type: "object", properties: {} },
			async execute(_id, _params, signal) {
				const socket = new WebSocket(${JSON.stringify(url)}, { headers: { Authorization: "Bearer websocket-test" } });
				return new Promise((resolve, reject) => {
					const cleanup = () => { signal?.removeEventListener("abort", abort); socket.close(); };
					const abort = () => { cleanup(); reject(new Error("aborted")); };
					signal?.addEventListener("abort", abort, { once: true });
					socket.onopen = () => socket.send("socket-ok");
					socket.onmessage = (event) => { cleanup(); resolve({ content: [{ type: "text", text: event.data }] }); };
					socket.onerror = () => { cleanup(); reject(new Error("socket failed")); };
				});
			}
		});
	};`;
}
