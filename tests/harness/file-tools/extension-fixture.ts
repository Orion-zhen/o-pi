import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type ExecuteResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown };
export interface ExecuteToolContext {
	cwd: string;
	sessionManager: { getSessionId(): string; getBranch(): SessionEntry[] };
	model?: { api: string; input: string[] };
}

export type ExecuteTool = (
	toolCallId: string,
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: ((result: ExecuteResult) => void) | undefined,
	ctx: ExecuteToolContext,
) => Promise<ExecuteResult>;

export async function executeTool(
	registered: Array<{ name: string; execute?: ExecuteTool }>,
	name: string,
	params: unknown,
	ctx: ExecuteToolContext,
	signal?: AbortSignal,
	onUpdate?: (result: ExecuteResult) => void,
): Promise<ExecuteResult> {
	const tool = registered.find((item) => item.name === name);
	if (tool?.execute === undefined) throw new Error(`${name} execute not registered`);
	return tool.execute(`${name}-1`, params, signal, onUpdate, ctx);
}

export function textResult(result: ExecuteResult): string {
	return result.content
		.filter((item): item is { type: string; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}
