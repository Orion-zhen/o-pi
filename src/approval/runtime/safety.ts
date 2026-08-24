import { isToolCallEventType, type ToolCallEvent, type ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { checkDeniedText } from "../../bash-tool/pattern-guard.js";
import { loadBashToolConfig } from "../../bash-tool/config.js";
import { loadFileToolsConfig } from "../../file-tools/config.js";
import { preflightWriteAccess } from "../../filesystem/kernel/access-preflight.js";

export async function precheckSafety(event: ToolCallEvent, cwd: string): Promise<ToolCallEventResult | undefined> {
	if (isToolCallEventType("bash", event)) {
		const config = await loadBashToolConfig();
		const match = checkDeniedText(event.input.command, config.safety);
		if (match !== null) {
			return { block: true, reason: `Blocked by safety policy: Text blocked by deny rule. Matched ${match.kind}: ${match.rule}` };
		}
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
