import os from "node:os";
import path from "node:path";
import { agentSchemaPath, defaultAgentConfigPath, readDefaultJsoncConfigSync } from "../../../src/harness/config-loader.js";
import type { TuiConfig, TuiSnapshot } from "../../../src/tui/shell/types.js";

export function defaultTuiConfig(): TuiConfig {
	const raw = readDefaultJsoncConfigSync({
		configPath: defaultAgentConfigPath("tui.jsonc"),
		schemaPath: agentSchemaPath("tui.schema.json"),
		label: "tui",
		createError: (message) => new Error(message),
	}) as TuiConfig & { $schema?: string };
	const { $schema: _schema, ...config } = raw;
	return config;
}

export function tuiSnapshot(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
	return {
		cwd: "/repo",
		status: "ready",
		thinkingLevel: "off",
		availableProviderCount: 0,
		hasPendingMessages: false,
		tools: { activeNames: [], allNames: [] },
		...overrides,
	};
}

export function homeSnapshot(context: TuiSnapshot["context"] = { tokens: 74_000, contextWindow: 200_000, percent: 37 }): TuiSnapshot {
	const toolNames = ["ls", "read", "write", "edit", "find", "grep", "bash", "websearch", "webfetch", "subagent", "skill"];
	return tuiSnapshot({
		cwd: path.join(os.homedir(), "pi-dev"),
		git: "main",
		modelId: "deepseek-v4-flash-free",
		modelProvider: "opencode",
		modelReasoning: true,
		thinkingLevel: "high",
		availableProviderCount: 2,
		context,
		tools: { activeNames: toolNames, allNames: toolNames },
		skills: { totalCount: 3, modelInvocableCount: 1 },
	});
}

export function plainTheme() {
	return { fg: (_color: string, text: string) => text };
}
