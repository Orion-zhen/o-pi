declare module "@earendil-works/pi-coding-agent" {
	export function getAgentDir(): string;

	export interface ToolInfo {
		name: string;
		sourceInfo?: { source?: string };
	}

	export interface ExtensionUIContext {
		select(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
		confirm(title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<boolean>;
		input(title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
		editor(title: string, prefill?: string): Promise<string | undefined>;
	}

	export interface ExtensionContext {
		cwd: string;
		hasUI: boolean;
		ui: ExtensionUIContext;
		isProjectTrusted(): boolean;
	}

	export interface ToolResult {
		content: Array<{ type: "text"; text: string }>;
		details?: unknown;
	}

	export interface ToolDefinition<TParams = unknown> {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters: unknown;
		execute(
			toolCallId: string,
			params: TParams,
			signal: AbortSignal,
			onUpdate: ((result: ToolResult) => void) | undefined,
			ctx: ExtensionContext,
		): Promise<ToolResult>;
	}

	export interface ExtensionAPI {
		registerCommand(
			name: string,
			options: {
				description?: string;
				getArgumentCompletions?: (prefix: string) => Array<{ value: string; label?: string }> | null;
				handler(args: string, ctx: ExtensionContext): Promise<void> | void;
			},
		): void;
		registerTool<TParams>(definition: ToolDefinition<TParams>): void;
		on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => void): void;
		on(event: "session_shutdown", handler: (event: unknown, ctx: ExtensionContext) => void): void;
		getAllTools(): ToolInfo[];
		getActiveTools(): string[];
		setActiveTools(names: string[]): void;
	}
}
