import { stableExecutableFromCommand } from "./activity.js";

export interface StreamingToolCall {
	id: string;
	name: string;
	arguments: unknown;
}

export interface StreamingToolUpdate {
	previousToolCallId: string;
	toolCallId: string;
	toolName: string;
	args: Record<string, string>;
}

interface StreamingToolState {
	messageKey: string;
	activityId: string;
	name: string;
	argumentJson: string;
	pathLocked: boolean;
	path: string | undefined;
	commandLocked: boolean;
	command: string | undefined;
}

/** 将高频 toolcall delta 收敛为类别、稳定 path 和稳定 executable 的有限次更新。 */
export class StreamingToolCallTracker {
	private readonly calls = new Map<string, StreamingToolState>();

	start(messageKey: string, contentIndex: number, call: StreamingToolCall): StreamingToolUpdate {
		const streamKey = callStreamKey(messageKey, contentIndex);
		const activityId = call.id || streamKey;
		const state: StreamingToolState = {
			messageKey,
			activityId,
			name: call.name || "tool",
			argumentJson: "",
			pathLocked: false,
			path: undefined,
			commandLocked: false,
			command: undefined,
		};
		this.calls.set(streamKey, state);
		return updateFor(state, activityId);
	}

	delta(
		messageKey: string,
		contentIndex: number,
		call: StreamingToolCall,
		delta: string,
	): StreamingToolUpdate | undefined {
		const streamKey = callStreamKey(messageKey, contentIndex);
		const state = this.requireState(streamKey);
		const previousToolCallId = state.activityId;
		let changed = false;

		state.argumentJson += delta;
		if (call.id.length > 0 && call.id !== state.activityId) {
			state.activityId = call.id;
			changed = true;
		}
		if (call.name.length > 0 && call.name !== state.name) {
			state.name = call.name;
			changed = true;
		}
		if (!state.pathLocked) {
			const completedPath = completedTopLevelStringProperty(state.argumentJson, "path");
			if (completedPath !== undefined) {
				state.pathLocked = true;
				state.path = completedPath;
				changed = true;
			}
		}
		if (!state.commandLocked) {
			const command = stringProperty(call.arguments, "command");
			if (command !== undefined && stableExecutableFromCommand(command, false) !== undefined) {
				state.commandLocked = true;
				state.command = command;
				changed = true;
			}
		}

		return changed ? updateFor(state, previousToolCallId) : undefined;
	}

	end(messageKey: string, contentIndex: number, call: StreamingToolCall): StreamingToolUpdate {
		const streamKey = callStreamKey(messageKey, contentIndex);
		const state = this.requireState(streamKey);
		const previousToolCallId = state.activityId;
		if (call.id.length > 0) state.activityId = call.id;
		if (call.name.length > 0) state.name = call.name;
		if (!state.pathLocked) {
			state.pathLocked = true;
			state.path = stringProperty(call.arguments, "path");
		}
		if (!state.commandLocked) {
			state.commandLocked = true;
			state.command = stringProperty(call.arguments, "command");
		}
		return updateFor(state, previousToolCallId);
	}

	finish(toolCallId: string): void {
		for (const [streamKey, state] of this.calls) {
			if (state.activityId === toolCallId) this.calls.delete(streamKey);
		}
	}

	abortMessage(messageKey: string): string[] {
		const activityIds: string[] = [];
		for (const [streamKey, state] of this.calls) {
			if (state.messageKey !== messageKey) continue;
			activityIds.push(state.activityId);
			this.calls.delete(streamKey);
		}
		return activityIds;
	}

	clear(): void {
		this.calls.clear();
	}

	private requireState(streamKey: string): StreamingToolState {
		const state = this.calls.get(streamKey);
		if (state === undefined) throw new Error(`Discord presence tool stream did not start: ${streamKey}`);
		return state;
	}
}

/** 仅返回顶层属性中已收到结束引号的完整 JSON 字符串值。 */
export function completedTopLevelStringProperty(source: string, property: string): string | undefined {
	let depth = 0;
	for (let cursor = 0; cursor < source.length;) {
		const character = source[cursor] ?? "";
		if (character === "{") {
			depth += 1;
			cursor += 1;
			continue;
		}
		if (character === "}" || character === "]") {
			depth = Math.max(0, depth - 1);
			cursor += 1;
			continue;
		}
		if (character === "[") {
			depth += 1;
			cursor += 1;
			continue;
		}
		if (character !== "\"") {
			cursor += 1;
			continue;
		}

		const keyEnd = jsonStringEnd(source, cursor);
		if (keyEnd === undefined) return undefined;
		const key = decodeJsonString(source.slice(cursor, keyEnd));
		if (depth === 1 && key === property) {
			let valueStart = skipWhitespace(source, keyEnd);
			if (source[valueStart] === ":") valueStart = skipWhitespace(source, valueStart + 1);
			else {
				cursor = keyEnd;
				continue;
			}
			if (source[valueStart] !== "\"") return undefined;
			const valueEnd = jsonStringEnd(source, valueStart);
			if (valueEnd === undefined) return undefined;
			return decodeJsonString(source.slice(valueStart, valueEnd));
		}
		cursor = keyEnd;
	}
	return undefined;
}

function updateFor(state: StreamingToolState, previousToolCallId: string): StreamingToolUpdate {
	return {
		previousToolCallId,
		toolCallId: state.activityId,
		toolName: state.name,
		args: {
			...(state.path === undefined ? {} : { path: state.path }),
			...(state.command === undefined ? {} : { command: state.command }),
		},
	};
}

function callStreamKey(messageKey: string, contentIndex: number): string {
	return `stream:${messageKey}:${contentIndex}`;
}

function jsonStringEnd(source: string, start: number): number | undefined {
	let escaped = false;
	for (let cursor = start + 1; cursor < source.length; cursor += 1) {
		const character = source[cursor] ?? "";
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "\"") return cursor + 1;
	}
	return undefined;
}

function decodeJsonString(source: string): string | undefined {
	try {
		const value: unknown = JSON.parse(source);
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

function skipWhitespace(source: string, start: number): number {
	let cursor = start;
	while (cursor < source.length && /\s/u.test(source[cursor] ?? "")) cursor += 1;
	return cursor;
}

function stringProperty(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = (value as Record<string, unknown>)[key];
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}
