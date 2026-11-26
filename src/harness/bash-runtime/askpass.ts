import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { installationRoot } from "../runtime/paths.ts";
import path from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

export type Askpass = (retry: boolean, signal: AbortSignal) => Promise<string | undefined>;

export function withAskpass(operations: BashOperations, ask: Askpass): BashOperations {
	return { async exec(command, cwd, options) {
		const key = randomBytes(32).toString("hex");
		const lifetime = new AbortController();
		let pending = false;
		let retry = false;
		// 此端口只供本次 sudo 的助手回调，不属于 WebUI 的监听地址或部署配置。
		const server = createServer((request, response) => {
			if (request.headers.authorization !== key || pending || lifetime.signal.aborted) { response.writeHead(403).end(); return; }
			pending = true;
			const closed = new AbortController();
			response.once("close", () => closed.abort());
			const signal = AbortSignal.any([lifetime.signal, closed.signal, ...(options.signal ? [options.signal] : [])]);
			void ask(retry, signal).then((value) => {
				if (value === undefined || signal.aborted) { lifetime.abort(); response.writeHead(403).end(); }
				else { retry = true; response.end(`${value}\n`); }
			}, () => response.writeHead(500).end()).finally(() => { pending = false; });
		});
		const ready = once(server, "listening");
		server.listen(0, "127.0.0.1");
		await ready;
		try {
			const { port } = server.address() as AddressInfo;
			return await operations.exec(command, cwd, { ...options, env: { ...options.env,
				SUDO_ASKPASS: path.join(installationRoot(), "assets/sudo-askpass"), OPI_ASKPASS_RUNTIME: process.execPath,
				OPI_ASKPASS_PORT: String(port), OPI_ASKPASS_KEY: key,
			} });
		} finally {
			lifetime.abort();
			const closed = new Promise<void>((resolve) => server.close(() => resolve()));
			server.closeAllConnections();
			await closed;
		}
	} };
}
