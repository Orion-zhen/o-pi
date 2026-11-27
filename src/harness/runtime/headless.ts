import { EventEmitter } from "node:events";

if (process.argv[2] === "--opi-discord-daemon") {
	process.argv.splice(2, 1);
	await import("../discord-presence/coordinator-daemon.ts");
} else {
	await import("./environment.ts");
	EventEmitter.defaultMaxListeners = 20;
	process.emitWarning = () => {};
	const { runPiCli } = await import("./cli.ts");
	await runPiCli(async (startup) => (await import("../extensions.ts")).createHarnessExtensions({ startup }));
}
