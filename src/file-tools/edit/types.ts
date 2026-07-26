import type { DiagnosticsSummary } from "../shared/diagnostics.js";

export interface EditReplacement {
	old: string;
	new: string;
}

export interface EditMatchHint {
	line: number;
	old: string;
	new: string;
}

export interface EditParams {
	path: string;
	edits: EditReplacement[];
}

export interface EditMutationDetails {
	status: "updated" | "partially_stale";
	generation: string;
	diagnostic?: string;
	impact?: unknown;
}

export interface EditSuccess {
	status: "applied";
	path: string;
	replacements: number;
	old_version: string;
	new_version: string;
	old_size_bytes: number;
	new_size_bytes: number;
	diff: string;
	firstChangedLine?: number;
	lsp?: { diagnostics?: DiagnosticsSummary };
	repo_map?: EditMutationDetails;
}

export interface EditPreviewSuccess {
	status: "preview";
	path: string;
	replacements: number;
	diff: string;
	firstChangedLine?: number;
}
