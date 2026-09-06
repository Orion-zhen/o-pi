import { classifyTool, preserveStableMetadata, stableExecutableFromCommand } from "./activity.js";
import { completedTopLevelStringProperty, stringProperty } from "./streaming.js";
import type { PresenceActivity } from "./types.js";

interface ToolCall {
	id: string;
	name: string;
	arguments: unknown;
}

export type ToolStreamEvent = {
	messageKey: string;
	contentIndex: number;
	call: ToolCall;
} & ({ phase: "start" } | { phase: "end" } | { phase: "delta"; delta: string });

interface ActiveTool {
	id: string;
	activity: PresenceActivity;
	stream?: {
		key: string;
		messageKey: string;
		pathJson: string | undefined;
	};
}

/** 流式生成和实际执行共享同一份工具记录，只有启动事件改变活动顺序。 */
export class PresenceActivityTracker {
	private tools: ActiveTool[] = [];
	private turnActive = false;

	current(): PresenceActivity {
		return this.tools.at(-1)?.activity ?? { kind: this.turnActive ? "thinking" : "idle", tool: "" };
	}

	startTurn(): void { this.turnActive = true; }

	clear(): void {
		this.tools = [];
		this.turnActive = false;
	}

	startTool(id: string, name: string, args: unknown): void {
		const tool = this.tools.find((candidate) => candidate.id === id);
		const activity = preserveStableMetadata(tool?.activity, classifyTool(name, args));
		this.tools = this.tools.filter((candidate) => candidate !== tool);
		if (tool === undefined) this.tools.push({ id, activity });
		else {
			tool.activity = activity;
			this.tools.push(tool);
		}
		this.turnActive = true;
	}

	endTool(id: string): void {
		this.tools = this.tools.filter((tool) => tool.id !== id);
	}

	abortMessage(messageKey: string): void {
		this.tools = this.tools.filter((tool) => tool.stream?.messageKey !== messageKey);
	}

	stream(event: ToolStreamEvent): boolean {
		const { call, messageKey, contentIndex } = event;
		const key = `stream:${messageKey}:${contentIndex}`;
		if (event.phase === "start") {
			this.tools.push({
				id: call.id || key,
				activity: classifyTool(call.name || "tool", undefined),
				stream: { key, messageKey, pathJson: "" },
			});
			this.turnActive = true;
			return true;
		}
		const tool = this.tools.find((candidate) => candidate.stream?.key === key);
		if (tool?.stream === undefined) throw new Error(`Discord presence tool stream did not start: ${key}`);
		const previous = tool.activity;
		if (call.id.length > 0) tool.id = call.id;
		const name = call.name || previous.tool;
		if (event.phase === "end") {
			tool.activity = preserveStableMetadata(previous, classifyTool(name, call.arguments));
			tool.stream.pathJson = undefined;
			return true;
		}
		if (name !== previous.tool) tool.activity = preserveStableMetadata(previous, classifyTool(name, undefined));
		const kind = tool.activity.kind;
		if (kind === "reading" || kind === "editing" || kind === "writing" || call.name.length === 0) {
			if (tool.stream.pathJson !== undefined) {
				tool.stream.pathJson += event.delta;
				if (call.name.length > 0) {
					const path = completedTopLevelStringProperty(tool.stream.pathJson, "path");
					if (path !== undefined) {
						tool.activity = preserveStableMetadata(tool.activity, classifyTool(name, { path }));
						tool.stream.pathJson = undefined;
					}
				}
			}
		} else {
			tool.stream.pathJson = undefined;
		}
		if (kind === "shell" && tool.activity.executable === undefined) {
			const command = stringProperty(call.arguments, "command");
			const executable = command === undefined ? undefined : stableExecutableFromCommand(command, false);
			if (executable !== undefined) tool.activity = { ...tool.activity, executable };
		}
		return tool.activity !== previous;
	}
}
