export interface ThemeStub {
	fg(name: string, text: string): string;
	bg(name: string, text: string): string;
	bold(text: string): string;
}

export const theme: ThemeStub = {
	fg(_name: string, text: string) {
		return text;
	},
	bg(name: string, text: string) {
		return `<${name}>${text}</${name}>`;
	},
	bold(text: string) {
		return text;
	},
};

export interface Renderable {
	render(width: number): string[];
}

export type LifecycleHandler = (...args: unknown[]) => unknown;
export type RenderResult = (result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: ThemeStub, context: unknown) => Renderable;
export type RenderCall = (args: unknown, theme: ThemeStub, context: unknown) => Renderable;
export type ExecuteResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown };
export type ExecuteTool = (
	toolCallId: string,
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: ((result: ExecuteResult) => void) | undefined,
	ctx: { cwd: string; sessionManager: { getSessionId(): string } },
) => Promise<ExecuteResult>;

export async function activateFileTools(handler: LifecycleHandler | undefined, mode: "tui" | "rpc" = "tui"): Promise<void> {
	await handler?.({}, { mode, ui: { notify() {} } });
}

export function renderToolResult(
	registered: Array<{ name: string; renderResult?: RenderResult }>,
	toolName: string,
	details: unknown,
	expanded = false,
	args?: unknown,
): string {
	const tool = registered.slice().reverse().find((item) => item.name === toolName);
	const component = tool?.renderResult?.(
		{ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details },
		{ expanded, isPartial: false },
		theme,
		{ args, cwd: "C:/Users/orion/.pi" },
	);
	return component?.render(120).join("\n") ?? "";
}

export function renderEditResult(
	registered: Array<{ name: string; renderResult?: RenderResult }>,
	details: unknown,
	expanded = false,
): string {
	const tool = registered.slice().reverse().find((item) => item.name === "edit");
	const component = tool?.renderResult?.(
		{ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details },
		{ expanded, isPartial: false },
		theme,
		{
			args: { path: "src/app.ts", edits: [{ old: "old", new: "new" }] },
			cwd: "/repo",
			expanded,
			lastComponent: undefined,
			state: {},
		},
	);
	return component?.render(120).join("\n") ?? "";
}

export function renderWriteResult(
	registered: Array<{ name: string; renderResult?: RenderResult }>,
	details: unknown,
	expanded = false,
): string {
	const tool = registered.slice().reverse().find((item) => item.name === "write");
	const component = tool?.renderResult?.(
		{ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details },
		{ expanded, isPartial: false },
		theme,
		{
			args: { path: "src/app.ts", content: "new" },
			cwd: "/repo",
			lastComponent: undefined,
		},
	);
	return component?.render(120).join("\n") ?? "";
}

export async function executeTool(
	registered: Array<{ name: string; execute?: ExecuteTool }>,
	name: string,
	params: unknown,
	ctx: { cwd: string; sessionManager: { getSessionId(): string } },
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
