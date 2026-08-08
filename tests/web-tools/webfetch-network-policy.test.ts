import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Server } from "node:net";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as undici from "undici";

import type { WebToolsConfig } from "../../src/web-tools/core/types.js";
import { createNetworkDispatcher, networkConfigSignature } from "../../src/web-tools/network/dispatcher.js";
import { isAllowedResolvedAddress, isPublicAddress, resolveAllowedAddresses, validateRequestUrl } from "../../src/web-tools/network/network-policy.js";

const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
});

describe("webfetch network policy", () => {
	it("只允许 http/https 且拒绝 userinfo、localhost 和字面私网 IP", () => {
		expect(validateRequestUrl("https://example.com/a#frag")).toMatchObject({ displayUrl: "https://example.com/a" });
		expect(validateRequestUrl("http://example.com")).toMatchObject({ displayUrl: "http://example.com/" });
		expect(validateRequestUrl(pathToFileURL("passwd").toString())).toMatchObject({ status: "failed", error: { code: "INVALID_URL" } });
		expect(validateRequestUrl("https://u:p@example.com")).toMatchObject({ status: "failed", error: { code: "INVALID_URL" } });
		expect(validateRequestUrl("https://localhost")).toMatchObject({ status: "failed", error: { code: "BLOCKED_ADDRESS" } });
		expect(validateRequestUrl("http://127.0.0.1")).toMatchObject({ status: "failed", error: { code: "BLOCKED_ADDRESS" } });
		expect(validateRequestUrl("http://[::1]")).toMatchObject({ status: "failed", error: { code: "BLOCKED_ADDRESS" } });
	});

	it("只把全球单播公网地址视为允许", () => {
		expect(isPublicAddress("8.8.8.8")).toBe(true);
		expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
		expect(isPublicAddress("10.0.0.1")).toBe(false);
		expect(isPublicAddress("192.168.1.1")).toBe(false);
		expect(isPublicAddress("169.254.169.254")).toBe(false);
		expect(isPublicAddress("::1")).toBe(false);
		expect(isPublicAddress("fc00::1")).toBe(false);
		expect(isPublicAddress("::ffff:192.168.1.1")).toBe(false);
	});

	it("混合公网和私网 DNS 结果整体拒绝", async () => {
		await expect(
			resolveAllowedAddresses("example.com", {
				lookup: async () => [
					{ address: "8.8.8.8", family: 4 },
					{ address: "10.0.0.1", family: 4 },
				],
			}),
		).rejects.toMatchObject({ name: "BLOCKED_ADDRESS" });
	});

	it("配置的 fake-ip CIDR 只放行 DNS 解析结果，不放行 URL 字面 IP", async () => {
		expect(isAllowedResolvedAddress("198.18.2.86", ["198.18.0.0/15"])).toBe(true);
		await expect(resolveAllowedAddresses("198.18.2.86", {
			allowedFakeIpRanges: ["198.18.0.0/15"],
		})).rejects.toMatchObject({ name: "BLOCKED_ADDRESS" });
		await expect(
			resolveAllowedAddresses("example.com", {
				allowedFakeIpRanges: ["198.18.0.0/15"],
				lookup: async () => [{ address: "198.18.2.86", family: 4 }],
			}),
		).resolves.toEqual([{ address: "198.18.2.86", family: 4 }]);
		expect(validateRequestUrl("https://198.18.2.86/")).toMatchObject({ status: "failed", error: { code: "BLOCKED_ADDRESS" } });
	});

	it("HTTP 代理接收本地安全解析后的目标 IP，并保留原始 Host", async () => {
		const requests: Array<{ url: string; host?: string }> = [];
		const proxy = createHttpServer((request, response) => {
			requests.push({ url: request.url ?? "", ...(request.headers.host !== undefined ? { host: request.headers.host } : {}) });
			response.end("proxied");
		});
		servers.push(proxy);
		const port = await listen(proxy);
		const dispatcher = createNetworkDispatcher(proxyNetwork({ http_proxy: `http://127.0.0.1:${port}` }), undici, {
			lookup: async () => [{ address: "8.8.8.8", family: 4 }],
		});

		try {
			const response = await undici.fetch("http://target.example/path?q=1", { dispatcher });
			expect(await response.text()).toBe("proxied");
			expect(requests).toEqual([{ url: "http://8.8.8.8/path?q=1", host: "target.example" }]);
		} finally {
			await dispatcher.close();
		}
	});

	it("HTTP 代理直接承载公网 IPv6 字面量目标，不执行 DNS 查询", async () => {
		let requests = 0;
		const proxy = createHttpServer((_request, response) => {
			requests += 1;
			response.end("ipv6 proxied");
		});
		servers.push(proxy);
		const port = await listen(proxy);
		const lookup = vi.fn(async () => {
			throw new Error("IPv6 literal must not use DNS");
		});
		const dispatcher = createNetworkDispatcher(proxyNetwork({ http_proxy: `http://127.0.0.1:${port}` }), undici, { lookup });

		try {
			const response = await undici.fetch("http://[2606:4700:4700::1111]/path", { dispatcher });
			expect(await response.text()).toBe("ipv6 proxied");
			expect(requests).toBe(1);
			expect(lookup).not.toHaveBeenCalled();
		} finally {
			await dispatcher.close();
		}
	});

	it("HTTPS 目标优先使用 https_proxy，并在 CONNECT 前校验目标 DNS", async () => {
		const httpConnects: string[] = [];
		const httpsConnects: string[] = [];
		const httpProxy = rejectingConnectProxy(httpConnects);
		const httpsProxy = rejectingConnectProxy(httpsConnects);
		servers.push(httpProxy, httpsProxy);
		const [httpPort, httpsPort] = await Promise.all([listen(httpProxy), listen(httpsProxy)]);
		const dispatcher = createNetworkDispatcher(proxyNetwork({
			http_proxy: `http://127.0.0.1:${httpPort}`,
			https_proxy: `http://127.0.0.1:${httpsPort}`,
		}), undici, {
			lookup: async () => [{ address: "8.8.8.8", family: 4 }],
		});

		try {
			await expect(undici.fetch("https://secure.example/data", { dispatcher })).rejects.toThrow();
			expect(httpConnects).toEqual([]);
			expect(httpsConnects).toEqual(["8.8.8.8:443"]);
		} finally {
			await dispatcher.close();
		}
	});

	it("代理模式在发出请求前拒绝解析到私网的目标", async () => {
		let requests = 0;
		const proxy = createHttpServer((_request, response) => {
			requests += 1;
			response.end("unexpected");
		});
		servers.push(proxy);
		const port = await listen(proxy);
		const dispatcher = createNetworkDispatcher(proxyNetwork({ http_proxy: `http://127.0.0.1:${port}` }), undici, {
			lookup: async () => [{ address: "10.0.0.1", family: 4 }],
		});

		try {
			await expect(undici.fetch("http://private.example/", { dispatcher })).rejects.toMatchObject({
				cause: { code: "EACCES" },
			});
			expect(requests).toBe(0);
		} finally {
			await dispatcher.close();
		}
	});

	it("SOCKS5 代理接收安全解析后的目标，并承载 HTTP 请求", async () => {
		const targets: string[] = [];
		const requests: string[] = [];
		const proxy = createSocks5Server(targets, requests);
		servers.push(proxy);
		const port = await listen(proxy);
		const dispatcher = createNetworkDispatcher(proxyNetwork({ socks5_proxy: `socks5://127.0.0.1:${port}` }), undici, {
			lookup: async () => [{ address: "8.8.8.8", family: 4 }],
		});
		const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

		try {
			const response = await undici.fetch("http://socks.example/resource", { dispatcher });
			expect(await response.text()).toBe("through socks");
			expect(targets).toEqual(["8.8.8.8:80"]);
			expect(requests[0]).toContain("get /resource http/1.1");
			expect(requests[0]).toContain("host: socks.example");
		} finally {
			emitWarning.mockRestore();
			await dispatcher.close();
		}
	});

	it("网络签名规范化等价配置、区分启用端点且不暴露认证信息", () => {
		const first = proxyNetwork({ enabled: false, http_proxy: "http://unused.example" });
		first.fake_ip_ranges = ["198.19.0.0/16", "198.18.0.0/16"];
		const second = proxyNetwork({ enabled: false });
		second.fake_ip_ranges = [...first.fake_ip_ranges].reverse();
		expect(networkConfigSignature(first)).toBe(networkConfigSignature(second));

		const authenticated = networkConfigSignature(proxyNetwork({ http_proxy: "http://user:secret@proxy.example" }));
		expect(authenticated).not.toBe(networkConfigSignature(proxyNetwork({ http_proxy: "http://proxy.example" })));
		expect(authenticated).not.toContain("secret");
	});
});

function proxyNetwork(proxy: Partial<WebToolsConfig["network"]["proxy"]>): WebToolsConfig["network"] {
	return {
		proxy: {
			enabled: true,
			http_proxy: "",
			https_proxy: "",
			socks5_proxy: "",
			...proxy,
		},
		fake_ip_ranges: [],
	};
}

function rejectingConnectProxy(connects: string[]): Server {
	const server = createHttpServer();
	server.on("connect", (request, socket) => {
		connects.push(request.url ?? "");
		socket.on("error", () => undefined);
		socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
	});
	return server;
}

function createSocks5Server(targets: string[], requests: string[]): Server {
	return createNetServer((socket) => {
		let stage: "greeting" | "connect" | "request" | "done" = "greeting";
		let pending = Buffer.alloc(0);
		socket.on("error", () => undefined);
		socket.on("data", (chunk) => {
			pending = Buffer.concat([pending, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
			while (stage !== "done") {
				if (stage === "greeting") {
					const methodCount = pending[1];
					if (methodCount === undefined || pending.length < methodCount + 2) return;
					pending = pending.subarray(methodCount + 2);
					stage = "connect";
					socket.write(Buffer.from([5, 0]));
					continue;
				}
				if (stage === "connect") {
					if (pending.length < 10) return;
					if (pending[0] !== 5 || pending[1] !== 1 || pending[3] !== 1) {
						socket.destroy(new Error("unexpected SOCKS5 connect request"));
						return;
					}
					const address = [...pending.subarray(4, 8)].join(".");
					const port = pending.readUInt16BE(8);
					targets.push(`${address}:${port}`);
					pending = pending.subarray(10);
					stage = "request";
					socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
					continue;
				}
				const headerEnd = pending.indexOf("\r\n\r\n");
				if (headerEnd === -1) return;
				requests.push(pending.subarray(0, headerEnd + 4).toString("utf8").toLowerCase());
				stage = "done";
				const body = "through socks";
				socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
			}
		});
	});
}

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", onError);
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("test server has no TCP address"));
				return;
			}
			resolve(address.port);
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => error === undefined ? resolve() : reject(error));
	});
}
