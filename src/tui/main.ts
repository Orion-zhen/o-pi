#!/usr/bin/env bun
import "../harness/runtime/environment.ts";
import { EventEmitter } from "node:events";
import { main, parseArgs } from "@earendil-works/pi-coding-agent";
import { runChildProcess } from "../harness/runtime/invocation.ts";

EventEmitter.defaultMaxListeners = 20;
process.title = "opi";
process.emitWarning = () => {};

if (!(await runChildProcess())) {
	const args = process.argv.slice(2);
	const parsed = parseArgs(args);
	if (["install", "remove", "uninstall", "update", "list", "config"].includes(args[0] ?? "")) {
		console.error("opi does not manage Pi packages. Update opi from its source repository.");
		process.exit(1);
	}
	const extensionFactories = parsed.noExtensions ? [] : (await import("./extensions.ts")).createTuiExtensions();
	await main(args, { extensionFactories });
}
