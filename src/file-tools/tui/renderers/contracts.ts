export type ToolTextResult = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
};

export type ToolReadResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
};

export interface TextRenderContext {
	lastComponent?: unknown;
	cwd: string;
	args?: unknown;
}

export interface PartialTextRenderContext extends TextRenderContext {
	isPartial?: boolean;
}
