import type { DiagnosticsSummary } from "../shared/diagnostics.js";
import type { MutationLineRange } from "../shared/mutation-diagnostics.js";

export interface EditReplacement {
	old: string;
	new: string;
	replace_all?: boolean;
}

export type EditLineRange = MutationLineRange;

export interface EditMatchHint {
	line: number;
	old: string;
	new: string;
}

export interface EditFormatCandidate {
	line: number;
	old: string;
}

export interface EditAnchorCandidate {
	line: number;
	text: string;
}

export type EditNotFoundRecovery =
	| { kind: "dependent"; afterEditIndex: number }
	| { kind: "format"; candidate: EditFormatCandidate }
	| { kind: "anchors"; candidates: EditAnchorCandidate[] }
	| { kind: "none" };

export interface EditParams {
	path: string;
	edits: EditReplacement[];
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
}

export interface EditPreviewSuccess {
	status: "preview";
	path: string;
	replacements: number;
	diff: string;
	firstChangedLine?: number;
}
