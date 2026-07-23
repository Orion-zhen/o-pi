import { createHash } from "node:crypto";
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
import type {
	ExecutorContext,
	ForkExecutionContext,
	ForkManifest,
	ParentModel,
	ToolInfo,
} from "./types.js";

const FORK_RESOURCE_PREFIX = "pi-subagent-fork-";

export async function createForkExecutionContext(context: ExecutorContext): Promise<ForkExecutionContext> {
	const sessionManager = context.sessionManager;
	if (sessionManager === undefined) throw setupError("session manager is unavailable");
	if (context.systemPrompt === undefined) throw setupError("system prompt is unavailable");
	if (context.currentModel === undefined) throw setupError("current model is unavailable");
	if (context.activeTools === undefined) throw setupError("active tools are unavailable");
	if (context.allTools === undefined) throw setupError("tool metadata is unavailable");
	if (context.thinkingLevel === undefined || context.thinkingLevel === "") throw setupError("thinking level is unavailable");

	const sessionId = sessionManager.getSessionId();
	if (sessionId === "") throw setupError("session ID is unavailable");
	const cwd = await realpath(context.cwd).catch(() => {
		throw setupError("cwd cannot be resolved");
	});
	const model = context.currentModel;
	const activeTools = [...context.activeTools];
	const allTools = [...context.allTools];
	selectActiveToolInfo(activeTools, allTools);
	const entries = selectSnapshotEntries(context);
	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionId,
		timestamp,
		cwd,
	};
	const snapshot = serializeJsonl([header, ...entries]);
	const systemPrompt = context.systemPrompt;
	const root = await mkdtemp(path.join(os.tmpdir(), FORK_RESOURCE_PREFIX));
	const snapshotPath = path.join(root, "context.jsonl");
	const systemPromptPath = path.join(root, "system-prompt.txt");
	const manifestPath = path.join(root, "manifest.json");

	try {
		await writePrivateFile(snapshotPath, snapshot);
		await writePrivateFile(systemPromptPath, systemPrompt);
		const manifest: ForkManifest = {
			snapshotHash: hashText(snapshot),
			systemPromptHash: hashText(systemPrompt),
			modelHash: hashModel(model),
			toolsHash: hashTools(activeTools, allTools),
			thinkingLevel: context.thinkingLevel,
			sessionId,
			cwd,
		};
		await writePrivateFile(manifestPath, `${stableSerialize(manifest)}\n`);
		return {
			snapshotPath,
			systemPromptPath,
			manifestPath,
			systemPromptHash: manifest.systemPromptHash,
			model,
			activeTools,
			allTools,
			thinkingLevel: context.thinkingLevel,
			sessionId,
			cwd,
		};
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw setupError(errorMessage(error));
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

export async function loadForkManifest(filePath: string): Promise<ForkManifest> {
	try {
		const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
		if (!isRecord(parsed)) throw setupError("manifest is invalid");
		const required = ["snapshotHash", "systemPromptHash", "modelHash", "toolsHash", "thinkingLevel", "sessionId", "cwd"] as const;
		for (const field of required) {
			if (typeof parsed[field] !== "string" || parsed[field] === "") throw setupError(`manifest field ${field} is invalid`);
		}
		return {
			snapshotHash: manifestString(parsed, "snapshotHash"),
			systemPromptHash: manifestString(parsed, "systemPromptHash"),
			modelHash: manifestString(parsed, "modelHash"),
			toolsHash: manifestString(parsed, "toolsHash"),
			thinkingLevel: manifestString(parsed, "thinkingLevel"),
			sessionId: manifestString(parsed, "sessionId"),
			cwd: manifestString(parsed, "cwd"),
		};
	} catch (error) {
		throw forkError(error);
	}
}

export async function loadAndValidateForkSystemPrompt(systemPromptPath: string, manifestPath: string): Promise<string> {
	try {
		const [prompt, manifest] = await Promise.all([
			readFile(systemPromptPath, "utf8"),
			loadForkManifest(manifestPath),
		]);
		if (hashText(prompt) !== manifest.systemPromptHash) throw mismatch("systemPrompt");
		return prompt;
	} catch (error) {
		throw forkError(error);
	}
}

export async function validateForkRuntime(input: {
	manifestPath: string;
	snapshotPath?: string;
	model: ParentModel | undefined;
	activeTools: readonly string[];
	allTools: readonly ToolInfo[];
	thinkingLevel: string;
	sessionId: string;
	cwd: string;
}): Promise<void> {
	try {
		const manifest = await loadForkManifest(input.manifestPath);
		if (input.snapshotPath !== undefined) {
			const snapshot = await readFile(input.snapshotPath, "utf8");
			if (hashText(snapshot) !== manifest.snapshotHash) throw mismatch("snapshot");
		}
		if (input.model === undefined || hashModel(input.model) !== manifest.modelHash) throw mismatch("model");
		if (hashTools(input.activeTools, input.allTools) !== manifest.toolsHash) throw mismatch("tools");
		if (input.thinkingLevel !== manifest.thinkingLevel) throw mismatch("thinkingLevel");
		if (input.sessionId !== manifest.sessionId) throw mismatch("sessionId");
		if (path.resolve(input.cwd) !== path.resolve(manifest.cwd)) throw mismatch("cwd");
	} catch (error) {
		throw forkError(error);
	}
}

export function hashModel(model: ParentModel): string {
	return hashText(stableSerialize(model));
}

export function hashTools(activeTools: readonly string[], allTools: readonly ToolInfo[]): string {
	const selected = selectActiveToolInfo(activeTools, allTools).map(({ name, description, parameters }) => ({
		name,
		description,
		parameters,
	}));
	return hashText(stableSerialize(selected));
}

export function stableSerialize(value: unknown): string {
	return JSON.stringify(normalizeForStableJson(value) ?? null);
}

function selectSnapshotEntries(context: ExecutorContext): SessionEntry[] {
	const manager = context.sessionManager;
	if (manager === undefined) throw setupError("session manager is unavailable");
	const entries = manager.getEntries();
	let leafId: string | null;
	if (context.invocation === "tool") {
		leafId = resolveToolForkLeaf(manager.getLeafEntry(), context.toolCallId);
	} else if (context.invocation === "command") {
		leafId = manager.getLeafId();
	} else {
		throw setupError("invocation source is unavailable");
	}
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const selected = buildContextEntries(entries, leafId, byId)
		.filter((entry) => sessionEntryToContextMessages(entry).length > 0)
		.map((entry) => structuredClone(entry));
	for (let index = 0; index < selected.length; index++) {
		const entry = selected[index];
		if (entry !== undefined) entry.parentId = selected[index - 1]?.id ?? null;
	}
	return selected;
}

function resolveToolForkLeaf(leaf: SessionEntry | undefined, toolCallId: string | undefined): string | null {
	if (toolCallId === undefined || toolCallId === "") throw setupError("toolCallId is unavailable");
	if (leaf?.type !== "message" || leaf.message.role !== "assistant") throw setupError("session leaf is not the current assistant tool call");
	const matches = leaf.message.content.some((part) => part.type === "toolCall" && part.id === toolCallId && part.name === "subagent");
	if (!matches) throw setupError("session leaf does not contain the current subagent tool call");
	if (leaf.parentId === null) throw setupError("subagent tool call has no parent fork boundary");
	return leaf.parentId;
}

function selectActiveToolInfo(activeTools: readonly string[], allTools: readonly ToolInfo[]): ToolInfo[] {
	const byName = new Map(allTools.map((tool) => [tool.name, tool]));
	return activeTools.map((name) => {
		const tool = byName.get(name);
		if (tool === undefined) throw setupError(`active tool metadata is unavailable: ${name}`);
		return tool;
	});
}

function normalizeForStableJson(value: unknown, seen = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
	if (seen.has(value)) throw new Error("Cannot stable-serialize a cyclic value.");
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => normalizeForStableJson(item, seen) ?? null);
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const normalized = normalizeForStableJson(Reflect.get(value, key), seen);
			if (normalized !== undefined) result[key] = normalized;
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

function serializeJsonl(entries: Array<SessionHeader | SessionEntry>): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function writePrivateFile(filePath: string, content: string): Promise<void> {
	await writeFile(filePath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

function hashText(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function mismatch(field: string): Error {
	return new Error(`fork context mismatch: ${field}`);
}

function setupError(message: string): Error {
	return message.startsWith("fork setup error: ") ? new Error(message) : new Error(`fork setup error: ${message}`);
}

function forkError(error: unknown): Error {
	const message = errorMessage(error);
	if (message.startsWith("fork context mismatch: ")) return new Error(message);
	return setupError(message);
}

function manifestString(manifest: Record<string, unknown>, field: keyof ForkManifest): string {
	const value = manifest[field];
	if (typeof value !== "string") throw setupError(`manifest field ${field} is invalid`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
