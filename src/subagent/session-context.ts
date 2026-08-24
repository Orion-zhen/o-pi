import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	buildContextEntries,
	CURRENT_SESSION_VERSION,
	sessionEntryToContextMessages,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import type { ExecutorContext, ForkExecutionContext } from "./types.js";

const FORK_RESOURCE_PREFIX = "pi-subagent-fork-";

export async function createForkExecutionContext(context: ExecutorContext): Promise<ForkExecutionContext> {
	if (context.currentModel === undefined) throw new Error("current model is unavailable");
	const cwd = await realpath(context.cwd);
	const sessionId = context.sessionManager.getSessionId();
	const entries = selectSnapshotEntries(context);
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionId,
		timestamp: new Date().toISOString(),
		cwd,
	};
	const root = await mkdtemp(path.join(os.tmpdir(), FORK_RESOURCE_PREFIX));
	const snapshotPath = path.join(root, "context.jsonl");
	const systemPromptPath = path.join(root, "system-prompt.txt");

	try {
		await writePrivateFile(snapshotPath, serializeJsonl([header, ...entries]));
		await writePrivateFile(systemPromptPath, context.systemPrompt);
		return {
			snapshotPath,
			systemPromptPath,
			model: context.currentModel,
			activeTools: [...context.activeTools],
			thinkingLevel: context.thinkingLevel,
			sessionId,
			cwd,
		};
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

export async function cleanupForkExecutionContext(context: ForkExecutionContext): Promise<void> {
	await rm(path.dirname(context.snapshotPath), { recursive: true, force: true });
}

export function formatForkAssignment(agentBody: string, task: string): string {
	return [
		"You are a temporary branch of the primary agent. Complete only the assigned task, return the result to the primary agent, and do not call subagent.",
		"",
		"<agent_instructions>",
		agentBody.trim(),
		"</agent_instructions>",
		"",
		"<task>",
		task,
		"</task>",
	].join("\n");
}

export function loadForkSystemPrompt(filePath: string): Promise<string> {
	return readFile(filePath, "utf8");
}

function selectSnapshotEntries(context: ExecutorContext): SessionEntry[] {
	const manager = context.sessionManager;
	const entries = manager.getEntries();
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const leafId = context.invocation === "tool"
		? toolForkBoundary(manager.getLeafEntry(), context.toolCallId, byId)
		: manager.getLeafId();
	const selected = buildContextEntries(entries, leafId, byId)
		.filter((entry) => sessionEntryToContextMessages(entry).length > 0)
		.map((entry) => structuredClone(entry));
	let parentId: string | null = null;
	for (const entry of selected) {
		entry.parentId = parentId;
		parentId = entry.id;
	}
	return selected;
}

function toolForkBoundary(
	leaf: SessionEntry | undefined,
	toolCallId: string,
	byId: ReadonlyMap<string, SessionEntry>,
): string {
	if (leaf === undefined) throw new Error("session leaf is unavailable");
	const visited = new Set<string>();
	let entry: SessionEntry | undefined = leaf;
	while (entry !== undefined && !visited.has(entry.id)) {
		visited.add(entry.id);
		if (isCurrentSubagentCall(entry, toolCallId)) {
			if (entry.parentId === null) throw new Error("subagent tool call has no parent fork boundary");
			return entry.parentId;
		}
		entry = entry.parentId === null ? undefined : byId.get(entry.parentId);
	}
	throw new Error("current session branch does not contain the subagent tool call");
}

function isCurrentSubagentCall(entry: SessionEntry, toolCallId: string): boolean {
	return entry.type === "message"
		&& entry.message.role === "assistant"
		&& entry.message.content.some((part) => part.type === "toolCall" && part.id === toolCallId && part.name === "subagent");
}

function serializeJsonl(entries: Array<SessionHeader | SessionEntry>): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function writePrivateFile(filePath: string, content: string): Promise<void> {
	return writeFile(filePath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
}
