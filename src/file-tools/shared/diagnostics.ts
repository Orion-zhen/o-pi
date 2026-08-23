/** Diagnostics are optional mutation enhancements and never change commit status. */
export type DiagnosticStatus = "clean" | "warnings" | "errors" | "unavailable" | "timeout";
export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

export interface DiagnosticItem {
	severity: DiagnosticSeverity;
	line: number;
	column: number;
	message: string;
	code?: string;
	source?: string;
}

export interface DiagnosticsSummary {
	status: DiagnosticStatus;
	file_errors: number;
	file_warnings: number;
	new_errors: number;
	new_warnings: number;
	resolved_errors: number;
	resolved_warnings: number;
	baseline: "known" | "unknown";
	total_items: number;
	items: DiagnosticItem[];
}

interface DiagnosticSnapshotBase {
	source: string;
	uri: string;
	items: DiagnosticItem[];
	revision: number;
	version?: number;
}

export type DiagnosticSnapshot =
	| (DiagnosticSnapshotBase & { known: false })
	| (DiagnosticSnapshotBase & { known: true; updatedAt: number });
