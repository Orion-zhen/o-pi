import path from "node:path";
import { isToolCallEventType, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { ApprovalEffect, ApprovalRequest } from "./types.js";

const SYSTEM_PATH_PREFIXES = ["/etc/", "/usr/", "/bin/", "/sbin/", "/System/", "/Library/", "/var/"];

export function buildApprovalRequest(event: ToolCallEvent, cwd: string): ApprovalRequest | undefined {
	if (isToolCallEventType("bash", event)) {
		const command = event.input.command;
		if (typeof command !== "string" || command.trim().length === 0) return undefined;
		const effects = bashEffects(command);
		return {
			id: event.toolCallId,
			tool: "bash",
			action: "execute",
			summary: `Run command: ${command}`,
			subject: "command",
			targets: [{ kind: "command", value: command }],
			effects,
			raw_input: event.input,
		};
	}

	if (isToolCallEventType("write", event)) {
		const filePath = event.input.path;
		if (typeof filePath !== "string" || filePath.length === 0) return undefined;
		const targetPath = normalizeTargetPath(filePath, cwd);
		return {
			id: event.toolCallId,
			tool: "write",
			action: "write_file",
			summary: `Write file: ${targetPath}`,
			subject: "path",
			targets: [{ kind: "path", value: targetPath }],
			effects: pathEffects(targetPath),
			raw_input: event.input,
		};
	}

	if (isToolCallEventType("edit", event)) {
		const filePath = event.input.path;
		if (typeof filePath !== "string" || filePath.length === 0) return undefined;
		const targetPath = normalizeTargetPath(filePath, cwd);
		return {
			id: event.toolCallId,
			tool: "edit",
			action: "edit_file",
			summary: `Edit file: ${targetPath}`,
			subject: "path",
			targets: [{ kind: "path", value: targetPath }],
			effects: pathEffects(targetPath),
			raw_input: event.input,
		};
	}

	return undefined;
}

function bashEffects(command: string): ApprovalEffect[] {
	const effects: ApprovalEffect[] = ["execute"];
	if (/\b(sudo|systemctl|service|launchctl)\b/i.test(command)) addEffect(effects, "system_change");
	if (/\b(apt|apt-get|dnf|yum|pacman|brew|npm|pnpm|pip|uv|cargo)\b[\s\S]*\b(install|add|remove|uninstall|upgrade|update)\b/i.test(command)) {
		addEffect(effects, "install");
		addEffect(effects, "network");
	}
	if (/\b(git\s+push|npm\s+publish|gh\s+release|twine\s+upload)\b/i.test(command)) {
		addEffect(effects, "publish");
		addEffect(effects, "network");
		addEffect(effects, "external_side_effect");
	}
	if (/\b(rm\s+-[^\n;|&]*[rf][^\n;|&]*|rmdir|git\s+clean\b|git\s+reset\s+--hard|docker\s+system\s+prune)\b/i.test(command)) {
		addEffect(effects, "destructive");
	}
	if (/\b(kubectl\s+(apply|delete)|terraform\s+(apply|destroy)|docker\s+(rm|prune|system\s+prune))\b/i.test(command)) {
		addEffect(effects, "external_side_effect");
	}
	return effects;
}

function pathEffects(targetPath: string): ApprovalEffect[] {
	const effects: ApprovalEffect[] = ["write"];
	if (isSystemPath(targetPath)) addEffect(effects, "system_change");
	return effects;
}

function isSystemPath(targetPath: string): boolean {
	const normalized = targetPath.replace(/\\/g, "/");
	return SYSTEM_PATH_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function normalizeTargetPath(filePath: string, cwd: string): string {
	const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
	return absolute.replace(/\\/g, "/");
}

function addEffect(effects: ApprovalEffect[], effect: ApprovalEffect): void {
	if (!effects.includes(effect)) effects.push(effect);
}
