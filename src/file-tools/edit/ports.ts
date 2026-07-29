import type { TargetRef } from "../../filesystem/contracts/path.js";
import type { DiagnosticSnapshot, DiagnosticsSummary } from "../shared/diagnostics.js";
import type { EditLineRange, EditMutationDetails } from "./types.js";

export interface EditDiagnosticsSource {
	beforeEdit(input: {
		readonly target: TargetRef;
		readonly signal?: AbortSignal;
	}): Promise<DiagnosticSnapshot | undefined>;
	afterEdit(input: {
		readonly target: TargetRef;
		readonly content: string;
		readonly changedRanges: readonly EditLineRange[];
		readonly baseline?: DiagnosticSnapshot;
		readonly signal?: AbortSignal;
	}): Promise<DiagnosticsSummary | undefined>;
}

export interface EditMutationObserver {
	observe(input: {
		readonly target: TargetRef;
		readonly firstChangedLine?: number;
		readonly signal?: AbortSignal;
	}): Promise<EditMutationDetails | undefined>;
}
