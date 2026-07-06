import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionCommandContext, ExtensionContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { collectSkillCandidates, findSkillCandidate, loadSkill } from "./loader.js";
import { computeSkillContextState } from "./state.js";
import {
	SKILL_CONTEXT_ENTRY,
	SKILL_CONTEXT_STATUS_MESSAGE,
	type SkillActivationEntry,
	type SkillContextConfig,
	type SkillContextStatusMessage,
	type SkillDeactivationEntry,
} from "./types.js";
import { loadSkillContextConfig } from "./config.js";
import { skillStatusContent } from "./renderer.js";

type CommandRegistrar = Pick<ExtensionAPI, "registerCommand" | "appendEntry" | "getCommands" | "on" | "sendMessage">;
type SkillActionContext = Pick<ExtensionContext, "ui" | "sessionManager" | "cwd"> & Partial<Pick<ExtensionCommandContext, "getSystemPromptOptions">>;

/** 注册 /skill 管理命令，并用 input hook 接管 /skill:<name>，避免占用 clear/status skill 名。 */
export function registerSkillCommands(pi: CommandRegistrar): void {
	const registered = new Set<string>();

	const registerFixed = (name: string, handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>) => {
		if (registered.has(name)) return;
		registered.add(name);
		pi.registerCommand(name, { description: skillCommandDescription(name), handler });
	};

	registerFixed("skill", (args, ctx) => handleSkillCommand(pi, args, ctx));

	pi.on("input", async (event, ctx) => {
		const skillName = parseSkillInvocation(event.text);
		if (skillName === undefined) return;
		await loadSkillCommand(pi, skillName, ctx);
		return { action: "handled" };
	});
}

async function handleSkillCommand(pi: CommandRegistrar, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const trimmed = args.trim();
	if (trimmed.length === 0 || trimmed === "status") {
		await showSkillStatus(ctx);
		return;
	}
	if (trimmed === "clear" || trimmed.startsWith("clear ")) {
		await clearSkill(pi, trimmed.slice("clear".length).trim(), ctx);
		return;
	}
	ctx.ui.notify("usage: /skill | /skill clear [name|--all|--hard]", "warning");
}

export async function loadSkillCommand(
	pi: Pick<ExtensionAPI, "appendEntry" | "getCommands" | "sendMessage">,
	name: string,
	ctx: SkillActionContext,
	configOverride?: SkillContextConfig,
): Promise<void> {
	const config = configOverride ?? await loadSkillContextConfig();
	if (!config.enabled) {
		ctx.ui.notify("skill context disabled", "warning");
		return;
	}

	const candidates = currentCandidates(ctx.getSystemPromptOptions?.(), pi.getCommands());
	const candidate = findSkillCandidate(name, candidates);
	if (candidate === undefined) {
		ctx.ui.notify(`skill ${name} not found`, "error");
		return;
	}

	const state = computeSkillContextState(ctx.sessionManager.getBranch());
	if (state.active.length >= config.max_active && config.on_load_conflict === "replace") {
		for (const skill of state.active.filter((activeSkill) => activeSkill.name !== name)) {
			appendDeactivation(pi, { name: skill.name, mode: config.clear_mode, reason: "conflict_replace" });
		}
	}

	const loaded = await loadSkill(candidate, config);
	const activation: SkillActivationEntry = {
		kind: "activation",
		...loaded,
		scope: "task",
		loadedAt: new Date().toISOString(),
	};
	pi.appendEntry<SkillActivationEntry>(SKILL_CONTEXT_ENTRY, activation);
	emitStatusCard(pi, { action: "loaded", name: loaded.name, chars: loaded.body.length, path: loaded.path });
}

export async function clearSkill(
	pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">,
	args: string,
	ctx: ExtensionCommandContext,
	configOverride?: SkillContextConfig,
): Promise<void> {
	const config = configOverride ?? await loadSkillContextConfig();
	if (!config.enabled) {
		ctx.ui.notify("skill context disabled", "warning");
		return;
	}
	const parsed = parseClearArgs(args, config.clear_mode);
	appendDeactivation(pi, { ...(parsed.name !== undefined ? { name: parsed.name } : {}), mode: parsed.mode, reason: "user_clear" });
	emitStatusCard(pi, {
		action: parsed.mode === "hard" ? "cleared" : "inactive",
		...(parsed.name !== undefined ? { name: parsed.name } : {}),
		mode: parsed.mode,
	});
}

export async function showSkillStatus(ctx: ExtensionCommandContext): Promise<void> {
	const state = computeSkillContextState(ctx.sessionManager.getBranch());
	const active = state.active.map((skill) => `  ${skill.name} · ${skill.body.length} chars · ${skill.path}`);
	const retainedNames = new Set(state.retained.map((skill) => skill.name));
	const inactive = state.retained
		.filter((skill) => !state.active.some((activeSkill) => activeSkill.name === skill.name))
		.map((skill) => `  ${skill.name} · lazy`);
	const hard = [...state.hardClearedNames].filter((name) => !retainedNames.has(name)).map((name) => `  ${name}`);
	ctx.ui.notify(
		[
			"Skills",
			"active:",
			...(active.length > 0 ? active : ["  none"]),
			"inactive retained:",
			...(inactive.length > 0 ? inactive : ["  none"]),
			"hard cleared:",
			...(hard.length > 0 ? hard : ["  none"]),
		].join("\n"),
		"info",
	);
}

function currentCandidates(options: BuildSystemPromptOptions | undefined, commands: SlashCommandInfo[]) {
	return collectSkillCandidates(options, commands);
}

function parseSkillInvocation(text: string): string | undefined {
	const match = text.match(/^\/skill:([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:\s|$)/);
	if (match === null) return undefined;
	const name = match[1];
	if (name === undefined || name.includes("--")) return undefined;
	return name;
}

function appendDeactivation(
	pi: Pick<ExtensionAPI, "appendEntry">,
	input: { name?: string; mode: SkillDeactivationEntry["mode"]; reason: SkillDeactivationEntry["reason"] },
): void {
	const entry: SkillDeactivationEntry = {
		kind: "deactivation",
		...(input.name !== undefined ? { name: input.name } : {}),
		mode: input.mode,
		reason: input.reason,
		clearedAt: new Date().toISOString(),
	};
	pi.appendEntry<SkillDeactivationEntry>(SKILL_CONTEXT_ENTRY, entry);
}

function emitStatusCard(pi: Pick<ExtensionAPI, "sendMessage">, details: SkillContextStatusMessage): void {
	pi.sendMessage<SkillContextStatusMessage>({
		customType: SKILL_CONTEXT_STATUS_MESSAGE,
		content: skillStatusContent(details),
		display: true,
		details,
	});
}

function parseClearArgs(args: string, defaultMode: SkillDeactivationEntry["mode"]): { name?: string; mode: SkillDeactivationEntry["mode"] } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	let mode = defaultMode;
	let name: string | undefined;
	for (const part of parts) {
		if (part === "--hard") mode = "hard";
		else if (part === "--all") name = undefined;
		else name = part;
	}
	return { ...(name !== undefined ? { name } : {}), mode };
}

function skillCommandDescription(name: string): string {
	if (name === "skill") return "Show or clear loaded skill context";
	return "Manage skill context";
}
