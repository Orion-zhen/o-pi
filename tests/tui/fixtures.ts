import os from "node:os";
import path from "node:path";

import type { TuiFooterSnapshot } from "../../src/tui/types.js";

export function footerSnapshot(
	context: TuiFooterSnapshot["context"] = { tokens: 74_000, contextWindow: 200_000, percent: 37 },
): TuiFooterSnapshot {
	const toolNames = ["ls", "read", "write", "edit", "find", "grep", "bash", "websearch", "webfetch", "subagent", "skill"];
	return {
		cwd: path.join(os.homedir(), "pi-dev"),
		git: "main",
		modelId: "deepseek-v4-flash-free",
		modelProvider: "opencode",
		modelReasoning: true,
		thinkingLevel: "high",
		availableProviderCount: 2,
		context,
		status: "ready",
		tools: { activeNames: toolNames, totalCount: 11, allNames: toolNames },
		skills: { totalCount: 3, modelInvocableCount: 1 },
	};
}

export function plainTheme() {
	return { fg: (_color: string, text: string) => text };
}
