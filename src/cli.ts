#!/usr/bin/env bun
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";
import { main, parseArgs } from "@earendil-works/pi-coding-agent";

process.title = "opi";
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = () => {};
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);

if (process.argv[2] === "--opi-discord-daemon") {
	process.argv.splice(2, 1);
	await import("./discord-presence/coordinator-daemon.js");
} else {
	await runCli();
}

async function runCli(): Promise<void> {
	const args = process.argv.slice(2);
	const parsed = parseArgs(args);
	if (["install", "remove", "uninstall", "update", "list", "config"].includes(args[0] ?? "")) {
		console.error("opi does not manage Pi packages. Update opi from its source repository.");
		process.exit(1);
	}
	const extensionFactories = parsed.noExtensions ? [] : (await import("./extensions.js")).extensions;
	await main(args, { extensionFactories });
}
