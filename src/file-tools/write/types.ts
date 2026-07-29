import type { DiagnosticsSummary } from "../shared/diagnostics.js";

export interface WriteParams {
	path: string;
	content: string;
}

export interface WritePreviewSuccess {
	status: "preview";
	path: string;
	diff: string;
	firstChangedLine?: number;
}

export interface WriteSuccess {
	status: "written";
	path: string;
	bytes: number;
	action: "create" | "modify";
	before_version?: string;
	after_version: string;
	before_size_bytes?: number;
	after_size_bytes: number;
	diff: string;
	firstChangedLine?: number;
	lsp?: { diagnostics?: DiagnosticsSummary };
}
