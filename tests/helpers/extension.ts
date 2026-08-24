import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ExtensionHandler = (...args: unknown[]) => unknown;

export interface CapturedExtensionResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
}

export interface CapturedExtensionTool {
	name: string;
	parameters?: unknown;
	renderCall?: (args: unknown, theme: unknown, context: unknown) => { render(width: number): string[] };
	renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => { render(width: number): string[] };
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		context: unknown,
	): Promise<CapturedExtensionResult>;
}

export function registerExtension<TTool = CapturedExtensionTool>(
	extension: (pi: ExtensionAPI) => void,
	api: Record<string, unknown> = {},
): { registered: TTool[]; handlers: Map<string, ExtensionHandler> } {
	const registered: TTool[] = [];
	const handlers = new Map<string, ExtensionHandler>();
	const host: Partial<ExtensionAPI> = {
		events: createEventBus(),
		...api,
		registerTool(tool) {
			registered.push(tool as TTool);
		},
		on: ((name: string, handler: ExtensionHandler) => {
			handlers.set(name, handler);
		}) as ExtensionAPI["on"],
	};
	extension(host as ExtensionAPI);
	return { registered, handlers };
}
