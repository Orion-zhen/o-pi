import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import agentsPrompts from "./extensions/agents-prompts.ts";
import approvalGate from "./extensions/approval-gate.ts";
import autoTitle from "./extensions/auto-title.ts";
import bashTool from "./extensions/bash-tool.ts";
import { createToolsExtension } from "./extensions/cmd-slash-tools.ts";
import type { ToolStartupOptions } from "./tool-defaults/initial.ts";
import codemode from "./extensions/codemode.ts";
import codexSpeed from "./extensions/codex-speed.ts";
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
import { registerTelemetry, type TelemetryService } from "./telemetry/service.ts";

interface HarnessOptions {
	startup?: ToolStartupOptions;
	subagent?: (pi: ExtensionAPI, telemetry: TelemetryService) => void;
	telemetry?: (pi: ExtensionAPI, service: TelemetryService) => void;
}

/** 工具与遥测在同一个 factory 内装配，每次加载独立创建状态。 */
export function createHarnessExtensions(options: HarnessOptions = {}): InlineExtension[] {
	return [
		{ name: "tool-search", builtin: true, factory: toolSearch },
		{ name: "codemode", builtin: true, factory: codemode },
		{ name: "mcp", builtin: true, factory: mcp },
		{ name: "agents-prompts", factory: agentsPrompts },
		{ name: "approval-gate", factory: approvalGate },
		{ name: "auto-title", factory: autoTitle },
		{ name: "tools-runtime", factory(pi) {
			const service = registerTelemetry(pi);
			bashTool(pi, service);
			fileTools(pi, service);
			skillContext(pi, service);
			(options.subagent ?? subagent)(pi, service);
			(options.telemetry ?? telemetry)(pi, service);
			webTools(pi, service);
		} },
		{ name: "cmd-slash-tools", factory: createToolsExtension({ startup: options.startup ?? {} }) },
		{ name: "codex-speed", factory: codexSpeed },
		{ name: "discord-presence", factory: discordPresence },
		{ name: "lsp", factory: lsp },
		{ name: "o-pet", factory: oPet },
		{ name: "openai-compatible-provider", factory: openAICompatibleProvider },
		{ name: "project-skills", factory: projectSkills },
		{ name: "prune", factory: prune },
		{ name: "stats", factory: stats },
		{ name: "system-prompt", factory: systemPrompt },
		{ name: "thinking-preferences", factory: thinkingPreferences },
		{ name: "usage", factory: usage },
	];
}

export const extensions = createHarnessExtensions();
