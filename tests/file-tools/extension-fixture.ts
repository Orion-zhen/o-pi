import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

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

export interface RegisteredTool {
	name: string;
	execute?: ExecuteTool;
	renderCall?: RenderCall;
	renderResult?: RenderResult;
}

export function registerExtension(
	extension: (pi: ExtensionAPI) => void,
	api: Record<string, unknown> = {},
): { registered: RegisteredTool[]; handlers: Map<string, LifecycleHandler> } {
	const registered: RegisteredTool[] = [];
	const handlers = new Map<string, LifecycleHandler>();
	extension({
		...api,
		registerTool(tool: RegisteredTool) {
			registered.push(tool);
		},
		on(name: string, handler: LifecycleHandler) {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI);
	return { registered, handlers };
}

export async function activateFileTools(handler: LifecycleHandler | undefined, mode: "tui" | "rpc" = "tui"): Promise<void> {
	await handler?.({}, { mode, ui: { notify() {} } });
}

export interface RenderOptions {
	readonly expanded?: boolean;
	readonly isPartial?: boolean;
	readonly args?: unknown;
	readonly content?: ExecuteResult["content"];
	readonly context?: unknown;
	readonly width?: number;
}

export function renderToolResult(
	registered: Array<{ name: string; renderResult?: RenderResult }>,
	toolName: string,
	details: unknown,
	options: RenderOptions = {},
): string {
	const tool = registered.slice().reverse().find((item) => item.name === toolName);
	const component = tool?.renderResult?.(
		{ content: options.content ?? [{ type: "text", text: JSON.stringify(details, null, 2) }], details },
		{ expanded: options.expanded ?? false, isPartial: options.isPartial ?? false },
		theme,
		options.context ?? { args: options.args, cwd: "C:/Users/orion/.pi" },
	);
	return component?.render(options.width ?? 120).join("\n") ?? "";
}

export function renderWriteResult(
	registered: Array<{ name: string; renderResult?: RenderResult }>,
	details: unknown,
	expanded = false,
): string {
	return renderToolResult(registered, "write", details, {
		expanded,
		context: {
			args: { path: "src/app.ts", content: "new" },
			cwd: "/repo",
			lastComponent: undefined,
		},
	});
}

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
