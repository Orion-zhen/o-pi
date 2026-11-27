#!/usr/bin/env bun
import "../harness/runtime/environment.ts";
import { EventEmitter } from "node:events";
import { runPiCli } from "../harness/runtime/cli.ts";
import { runChildProcess } from "../harness/runtime/invocation.ts";

EventEmitter.defaultMaxListeners = 20;
process.title = "opi";
process.emitWarning = () => {};

if (!(await runChildProcess())) {
	await runPiCli(async (startup) => (await import("./extensions.ts")).createTuiExtensions(startup));
}
