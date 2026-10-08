import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import agentsPrompts from "./extensions/agents-prompts.ts";
import approvalGate from "./extensions/approval-gate.ts";
import autoTitle from "./extensions/auto-title.ts";
import bashTool from "./extensions/bash-tool.ts";
import tools, { createToolsExtension } from "./extensions/cmd-slash-tools.ts";
import type { ToolStartupOptions } from "./tool-defaults/initial.ts";
import codemode from "./extensions/codemode.ts";
import toolSearch from "./extensions/tool-search.ts";
import discordPresence from "./extensions/discord-presence.ts";
import fileTools from "./extensions/file-tools.ts";
import lsp from "./extensions/lsp.ts";
import mcp from "./extensions/mcp.ts";
import oPet from "./extensions/o-pet.ts";
import openAICompatibleProvider from "./extensions/openai-compatible-provider.ts";
import projectSkills from "./extensions/project-skills.ts";
import prune from "./extensions/prune.ts";
import skillContext from "./extensions/skill-context.ts";
import stats from "./extensions/stats.ts";
import subagent from "./extensions/subagent.ts";
import systemPrompt from "./extensions/system-prompt.ts";
import telemetry from "./extensions/telemetry.ts";
import thinkingPreferences from "./extensions/thinking-preferences.ts";
import usage from "./extensions/usage.ts";
import webTools from "./extensions/web-tools.ts";

/** SDK 原生扩展列表。每次加载时由 factory 创建会话状态。 */
export const extensions: InlineExtension[] = [
	{ name: "tool-search", builtin: true, factory: toolSearch },
	{ name: "codemode", builtin: true, factory: codemode },
	{ name: "mcp", builtin: true, factory: mcp },
	{ name: "agents-prompts", factory: agentsPrompts },
	{ name: "approval-gate", factory: approvalGate },
	{ name: "auto-title", factory: autoTitle },
	{ name: "bash-tool", factory: bashTool },
	{ name: "cmd-slash-tools", factory: tools },
	{ name: "discord-presence", factory: discordPresence },
	{ name: "file-tools", factory: fileTools },
	{ name: "lsp", factory: lsp },
	{ name: "o-pet", factory: oPet },
	{ name: "openai-compatible-provider", factory: openAICompatibleProvider },
	{ name: "project-skills", factory: projectSkills },
	{ name: "prune", factory: prune },
	{ name: "skill-context", factory: skillContext },
	{ name: "stats", factory: stats },
	{ name: "subagent", factory: subagent },
	{ name: "system-prompt", factory: systemPrompt },
	{ name: "telemetry", factory: telemetry },
	{ name: "thinking-preferences", factory: thinkingPreferences },
	{ name: "usage", factory: usage },
	{ name: "web-tools", factory: webTools },
];

/** 无界面入口只传递原生解析结果，不接管 CLI 解析。 */
export function createHarnessExtensions(startup: ToolStartupOptions): InlineExtension[] {
	return extensions.map((extension) => extension.name === "cmd-slash-tools"
		? { name: extension.name, factory: createToolsExtension(undefined, undefined, undefined, startup) }
		: extension);
}
