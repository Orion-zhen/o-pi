#!/usr/bin/env bun
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";

registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.title = "opi-web";

if (process.argv[2] === "--opi-discord-daemon") {
	process.argv.splice(2, 1);
	await import("../harness/discord-presence/coordinator-daemon.ts");
} else if (process.env.PI_SUBAGENT_CHILD === "1") {
	await import("../cli.ts");
} else {
	const { values } = parseArgs({
		options: {
			host: { type: "string", default: "0.0.0.0" },
			port: { type: "string", default: "3141" },
			cwd: { type: "string", default: process.cwd() },
			cert: { type: "string" },
			key: { type: "string" },
			help: { type: "boolean" },
		},
		strict: true,
	});
	if (values.help) {
		console.log(
			"opi-web [--cwd PATH] [--host IP] [--port PORT] [--cert FILE --key FILE]\n默认监听 0.0.0.0:3141，免登录。仅用于可信局域网，请勿暴露到公网。TLS 证书可选。",
		);
	} else {
		const port = Number(values.port);
		if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("无效端口。");
		if (Boolean(values.cert) !== Boolean(values.key)) throw new Error("--cert 和 --key 必须同时指定。");
		const [{ GuiHost }, { startWebServer }] = await Promise.all([import("../gui/host/host.ts"), import("./server.ts")]);
		const gui = new GuiHost();
		const tls =
			values.cert && values.key ? { cert: await readFile(values.cert), key: await readFile(values.key) } : undefined;
		const server = await startWebServer(gui, {
			host: values.host,
			port,
			assets: process.env.PI_OPI_RESOURCE_DIR
				? path.join(process.env.PI_OPI_RESOURCE_DIR, "gui")
				: path.resolve("dist/gui"),
			...(tls ? { tls } : {}),
		});
		console.log(`opi-web: ${server.url}/`);
		let closing = false;
		const unsubscribe = gui.subscribe((event) => {
			if (event.type === "close") void close();
		});
		const close = async () => {
			if (closing) return;
			closing = true;
			unsubscribe();
			await server.close();
			await gui.dispose();
		};
		process.once("SIGINT", () => {
			void close();
		});
		process.once("SIGTERM", () => {
			void close();
		});
		void gui
			.start(values.cwd)
			.catch((error: unknown) => gui.dialogs.notify(error instanceof Error ? error.message : String(error), "error"));
	}
}
