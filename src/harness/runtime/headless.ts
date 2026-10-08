import { EventEmitter } from "node:events";

if (process.argv[2] === "--opi-discord-daemon") {
	process.argv.splice(2, 1);
	await import("../discord-presence/coordinator-daemon.ts");
} else {
	await import("./environment.ts");
	EventEmitter.defaultMaxListeners = 20;
	process.emitWarning = () => {};
	const { main, parseArgs } = await import("@earendil-works/pi-coding-agent");
	const args = process.argv.slice(2);
	const parsed = parseArgs(args);
	const extensionFactories = parsed.noExtensions ? [] : (await import("../extensions.ts")).createHarnessExtensions(parsed);
	await main(args, { extensionFactories });
}
