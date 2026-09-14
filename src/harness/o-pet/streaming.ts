import type { ToolCall } from "@earendil-works/pi-ai";

/** 在工具名首次可见或发生变化时发布，流式身份只保留在进程内。 */
export class OPetStreamingToolTracker {
	private readonly tools = new Map<string, string>();

	update(messageTimestamp: number, contentIndex: number, call: ToolCall): string | undefined {
		const key = `${messageTimestamp}:${contentIndex}`;
		if (call.name.length === 0 || this.tools.get(key) === call.name) return undefined;

		this.tools.set(key, call.name);
		return call.name;
	}

	clear(): void {
		this.tools.clear();
	}
}
