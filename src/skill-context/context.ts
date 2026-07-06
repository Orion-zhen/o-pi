import type { ContextEvent, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SKILL_CONTEXT_ENTRY, SKILL_CONTEXT_STATUS_MESSAGE, type SkillActivationEntry, type SkillContextEntry } from "./types.js";
import { hardOmittedActivationIndexes } from "./state.js";
import { serializeSkillContextEntry } from "./serialize.js";

type ContextMessage = ContextEvent["messages"][number];
interface BufferedSkillEntry {
	index: number;
	entry: SkillContextEntry;
}

interface SkillEntryState {
	active: Map<string, SkillActivationEntry>;
	retained: Map<string, SkillActivationEntry>;
}

/** 按 custom entry 在 branch 中的位置注入 selected skill，不改写真实 session 历史。 */
export function injectSkillContext(branchEntries: SessionEntry[], originalMessages: ContextMessage[]): ContextMessage[] {
	const skillEntries = skillEntriesWithBranchIndex(branchEntries);
	if (skillEntries.length === 0 && !hasSkillStatusMessages(branchEntries)) return originalMessages;

	const omitted = hardOmittedActivationIndexes(skillEntries.map((entry) => entry.data));
	let messageIndex = 0;
	let skillIndex = 0;
	let hasRealMessage = false;
	let skillState: SkillEntryState = emptySkillState();
	let buffered: BufferedSkillEntry[] = [];
	const output: ContextMessage[] = [];

	const flushSkills = () => {
		if (buffered.length === 0) return;
		const folded = foldBufferedSkillEntries(buffered, skillState, hasRealMessage, omitted);
		skillState = folded.nextState;
		for (const entry of folded.entries) {
			const text = serializeSkillContextEntry(entry);
			if (text !== undefined) output.push(syntheticUserMessage(text));
		}
		buffered = [];
	};

	for (const entry of branchEntries) {
		if (entry.type === "custom_message" && entry.customType === SKILL_CONTEXT_STATUS_MESSAGE) {
			messageIndex += 1;
			continue;
		}
		if (entry.type === "message" || entry.type === "custom_message") {
			flushSkills();
			const message = originalMessages[messageIndex];
			if (message !== undefined) output.push(message);
			messageIndex += 1;
			hasRealMessage = true;
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== SKILL_CONTEXT_ENTRY) continue;
		const current = skillEntries[skillIndex];
		skillIndex += 1;
		if (current !== undefined) buffered.push({ index: skillIndex - 1, entry: current.data });
	}

	flushSkills();
	output.push(...originalMessages.slice(messageIndex));
	return output;
}

/** 估算和测试使用的模型可见 skill context 文本；与 context hook 的折叠规则保持一致。 */
export function collectInjectedSkillContextTexts(branchEntries: SessionEntry[]): string[] {
	const skillEntries = skillEntriesWithBranchIndex(branchEntries);
	if (skillEntries.length === 0) return [];

	const omitted = hardOmittedActivationIndexes(skillEntries.map((entry) => entry.data));
	let skillIndex = 0;
	let hasRealMessage = false;
	let skillState: SkillEntryState = emptySkillState();
	let buffered: BufferedSkillEntry[] = [];
	const texts: string[] = [];

	const flushSkills = () => {
		if (buffered.length === 0) return;
		const folded = foldBufferedSkillEntries(buffered, skillState, hasRealMessage, omitted);
		skillState = folded.nextState;
		for (const entry of folded.entries) {
			const text = serializeSkillContextEntry(entry);
			if (text !== undefined) texts.push(text);
		}
		buffered = [];
	};

	for (const entry of branchEntries) {
		if (entry.type === "custom_message" && entry.customType === SKILL_CONTEXT_STATUS_MESSAGE) continue;
		if (entry.type === "message" || entry.type === "custom_message") {
			flushSkills();
			hasRealMessage = true;
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== SKILL_CONTEXT_ENTRY) continue;
		const current = skillEntries[skillIndex];
		skillIndex += 1;
		if (current !== undefined) buffered.push({ index: skillIndex - 1, entry: current.data });
	}
	flushSkills();
	return texts;
}

export function registerSkillContextInjection(pi: Pick<ExtensionAPI, "on">): void {
	pi.on("context", (event, ctx) => {
		const branchEntries = ctx.sessionManager.getBranch();
		const messages = injectSkillContext(branchEntries, event.messages);
		if (messages === event.messages) return;
		return { messages };
	});
}

function skillEntriesWithBranchIndex(branchEntries: SessionEntry[]): Array<{ data: SkillContextEntry }> {
	const entries: Array<{ data: SkillContextEntry }> = [];
	for (const entry of branchEntries) {
		if (entry.type === "custom" && entry.customType === SKILL_CONTEXT_ENTRY && isSkillContextEntry(entry.data)) {
			entries.push({ data: entry.data });
		}
	}
	return entries;
}

function hasSkillStatusMessages(branchEntries: SessionEntry[]): boolean {
	return branchEntries.some((entry) => entry.type === "custom_message" && entry.customType === SKILL_CONTEXT_STATUS_MESSAGE);
}

function foldBufferedSkillEntries(
	buffered: BufferedSkillEntry[],
	stateBefore: SkillEntryState,
	hasRealMessageBefore: boolean,
	omitted: Set<number>,
): { entries: SkillContextEntry[]; nextState: SkillEntryState } {
	const nextState = cloneSkillState(stateBefore);
	const touched = new Set<string>();
	const lastActivation = new Map<string, BufferedSkillEntry>();
	const lastDeactivation = new Map<string, SkillContextEntry>();

	for (const item of buffered) {
		const entry = item.entry;
		if (entry.kind === "activation") {
			touched.add(entry.name);
			nextState.active.set(entry.name, entry);
			nextState.retained.set(entry.name, entry);
			lastActivation.set(entry.name, item);
			continue;
		}

		const names = namesForDeactivation(entry.name, nextState);
		for (const name of names) {
			touched.add(name);
			nextState.active.delete(name);
			if (entry.mode === "hard") nextState.retained.delete(name);
			lastDeactivation.set(name, entry);
		}
	}

	const entries: SkillContextEntry[] = [];
	const emitted = new Set<SkillContextEntry>();
	for (const name of touched) {
		const active = nextState.active.get(name);
		const activation = lastActivation.get(name);
		if (active !== undefined && activation !== undefined && !omitted.has(activation.index)) {
			pushUnique(entries, emitted, active);
			continue;
		}

		const wasVisible = hasRealMessageBefore && (stateBefore.active.has(name) || stateBefore.retained.has(name));
		const deactivation = lastDeactivation.get(name);
		if (wasVisible && deactivation !== undefined) pushUnique(entries, emitted, deactivation);
	}

	return { entries, nextState };
}

function namesForDeactivation(name: string | undefined, state: SkillEntryState): string[] {
	if (name !== undefined) return [name];
	return [...new Set([...state.active.keys(), ...state.retained.keys()])];
}

function pushUnique(entries: SkillContextEntry[], emitted: Set<SkillContextEntry>, entry: SkillContextEntry): void {
	if (emitted.has(entry)) return;
	emitted.add(entry);
	entries.push(entry);
}

function emptySkillState(): SkillEntryState {
	return { active: new Map(), retained: new Map() };
}

function cloneSkillState(state: SkillEntryState): SkillEntryState {
	return {
		active: new Map(state.active),
		retained: new Map(state.retained),
	};
}

function syntheticUserMessage(content: string): ContextMessage {
	return { role: "user", content, timestamp: 0 };
}

function isSkillContextEntry(value: unknown): value is SkillContextEntry {
	if (typeof value !== "object" || value === null || !("kind" in value)) return false;
	const kind = (value as { kind?: unknown }).kind;
	return kind === "activation" || kind === "deactivation";
}
