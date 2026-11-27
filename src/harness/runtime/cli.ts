import { main, parseArgs, type Args, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { applyAgentDirArg } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/cli/agent-dir-arg.js";

export async function runPiCli(loadExtensions: (startup: Args) => Promise<InlineExtension[]>): Promise<void> {
	const profile = applyAgentDirArg(process.argv.slice(2));
	if (profile.kind === "error") {
		console.error(`Error: ${profile.message}`);
		process.exitCode = 1;
		return;
	}
	const { args } = profile;
	if (["install", "remove", "uninstall", "update", "list", "config"].includes(args[0] ?? "")) {
		console.error("opi does not manage Pi packages. Update opi from its source repository.");
		process.exitCode = 1;
		return;
	}
	const parsed = parseArgs(args);
	await main(args, { extensionFactories: parsed.noExtensions ? [] : await loadExtensions(parsed) });
}
