import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import agentsPrompts from "./extensions/agents-prompts.ts";
import approvalGate from "./extensions/approval-gate.ts";
import bashTool from "./extensions/bash-tool.ts";
import tools from "./extensions/cmd-slash-tools.ts";
import discordPresence from "./extensions/discord-presence.ts";
import fileTools from "./extensions/file-tools.ts";
import lsp from "./extensions/lsp.ts";
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
	{ name: "agents-prompts", factory: agentsPrompts },
	{ name: "approval-gate", factory: approvalGate },
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
