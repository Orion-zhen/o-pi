import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ReadToolCallEvent, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { loadSkillContextConfig } from "./config.js";
import { registerSkillCommands } from "./commands.js";
import { registerSkillContextInjection } from "./context.js";
import { registerSkillStatusRenderer } from "./renderer.js";
import { computeSkillContextState } from "./state.js";

/** 注册 host-side skill context：/skill 命令、上下文注入和重复 read 防护。 */
export function registerSkillContext(pi: ExtensionAPI): void {
	registerSkillStatusRenderer(pi);
	registerSkillCommands(pi);
	registerSkillContextInjection(pi);
	registerSkillReadDedupe(pi);
}

/** 使用 tool_call hook 阻止模型重复读取已作为 selected context 加载的 SKILL.md。 */
export function registerSkillReadDedupe(pi: Pick<ExtensionAPI, "on">): void {
	pi.on("tool_call", async (event, ctx) => {
		if (!isReadEvent(event)) return;
		const config = await loadSkillContextConfig();
		if (!config.enabled || !config.dedupe_read) return;
		const requested = await normalizePath(ctx.cwd, event.input.path);
		const state = computeSkillContextState(ctx.sessionManager.getBranch());
		for (const skill of state.retained) {
			const skillPath = await normalizePath(ctx.cwd, skill.path);
			if (requested === skillPath) {
				return {
					block: true,
					reason: `SKILL.md for skill "${skill.name}" is already loaded as selected skill context. Use that context; read referenced files only when needed.`,
				};
			}
		}
	});
}

async function normalizePath(cwd: string, value: string): Promise<string> {
	const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
	try {
		return await realpath(absolute);
	} catch {
		return absolute;
	}
}

function isReadEvent(event: ToolCallEvent): event is ReadToolCallEvent {
	return event.toolName === "read";
}
