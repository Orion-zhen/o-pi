import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import agentsPrompts from "./extensions/agents-prompts.js";
import approvalGate from "./extensions/approval-gate.js";
import bashTool from "./extensions/bash-tool.js";
import tools from "./extensions/cmd-slash-tools.js";
import discordPresence from "./extensions/discord-presence.js";
import fileTools from "./extensions/file-tools.js";
import lsp from "./extensions/lsp.js";
import oPet from "./extensions/o-pet.js";
import openAICompatibleProvider from "./extensions/openai-compatible-provider.js";
import projectSkills from "./extensions/project-skills.js";
import prune from "./extensions/prune.js";
import skillContext from "./extensions/skill-context.js";
import stats from "./extensions/stats.js";
import subagent from "./extensions/subagent.js";
import systemPrompt from "./extensions/system-prompt.js";
import telemetry from "./extensions/telemetry.js";
import thinkingPreferences from "./extensions/thinking-preferences.js";
import tui from "./extensions/tui.js";
import usage from "./extensions/usage.js";
import webTools from "./extensions/web-tools.js";

/** 保持原扩展目录的注册顺序，每次会话初始化重新创建模块状态。 */
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
	{ name: "tui", factory: tui },
	{ name: "usage", factory: usage },
	{ name: "web-tools", factory: webTools },
];
