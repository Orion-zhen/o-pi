#!/usr/bin/env bun
import "../harness/runtime/environment.ts";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseWebArgs } from "./cli.ts";
import { runChildProcess } from "../harness/runtime/invocation.ts";
import { installationRoot } from "../harness/runtime/paths.ts";

process.title = "opi-web";

if (!(await runChildProcess())) {
	const values = parseWebArgs(process.argv.slice(2));
	const [{ GuiHost }, { startWebServer }] = await Promise.all([import("../gui/host/host.ts"), import("./server.ts")]);
	const gui = new GuiHost();
	const tls =
		values.cert && values.key ? { cert: await readFile(values.cert), key: await readFile(values.key) } : undefined;
	const server = await startWebServer(gui, {
		host: values.host,
		port: values.port,
		assets: process.env.PI_OPI_RESOURCE_DIR
			? path.join(process.env.PI_OPI_RESOURCE_DIR, "gui")
			: path.join(installationRoot(), "dist/gui"),
		...(tls ? { tls } : {}),
	});
	console.log(`opi-web: ${server.url}/`);
	let closing = false;
	const close = async () => {
		if (closing) return;
		closing = true;
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
		.catch((error: unknown) => gui.reportError(error));
}
