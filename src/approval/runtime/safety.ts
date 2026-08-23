import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { checkDeniedText } from "../../bash-tool/pattern-guard.js";
import { loadBashToolConfig } from "../../bash-tool/config.js";
import { loadFileToolsConfig } from "../../file-tools/config.js";
import { preflightWriteAccess } from "../../filesystem/kernel/access-preflight.js";

export async function precheckSafety(event: ToolCallEvent, cwd: string): Promise<ToolCallEventResult | undefined> {
	if (event.toolName === "bash") {
		const command = typeof event.input.command === "string" ? event.input.command : undefined;
		if (command === undefined) return undefined;
		const config = await loadBashConfigForPrecheck();
		if (config === undefined) return undefined;
		const match = checkDeniedText(command, config.safety);
		if (match !== null) return { block: true, reason: `Blocked by safety policy: ${match.message} Matched ${match.kind}: ${match.rule}` };
		return undefined;
	}
	if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
	const filePath = typeof event.input.path === "string" ? event.input.path : undefined;
	if (filePath === undefined) return undefined;
	const config = await loadFileToolsConfig(cwd);
	if (!config.ok) return undefined;
	const preflight = await preflightWriteAccess({ cwd, path: filePath, blockedPaths: config.value.filesystem.blockedPaths });
	if (preflight.ok || preflight.error.code !== "blocked") return undefined;
	const matchedRule = typeof preflight.error.details?.["matchedRule"] === "string"
		? preflight.error.details["matchedRule"]
		: "unknown";
	return {
		block: true,
		reason: `Blocked by safety policy: Path is blocked by file-tools config. Matched path rule: ${matchedRule}`,
	};
}

async function loadBashConfigForPrecheck(): Promise<Awaited<ReturnType<typeof loadBashToolConfig>> | undefined> {
	try {
		return await loadBashToolConfig();
	} catch {
		return undefined;
	}
}
