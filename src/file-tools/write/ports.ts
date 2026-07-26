import type { TargetRef } from "../../filesystem/contracts/path.js";
import type { DiagnosticsSummary } from "../shared/diagnostics.js";
import type { WriteMutationDetails } from "./types.js";

export interface WriteDiagnosticsSource {
	afterWrite(input: {
		readonly target: TargetRef;
		readonly content: string;
		readonly signal?: AbortSignal;
	}): Promise<DiagnosticsSummary | undefined>;
}

export interface WriteMutationObserver {
	observe(input: {
		readonly target: TargetRef;
		readonly firstChangedLine?: number;
		readonly signal?: AbortSignal;
	}): Promise<WriteMutationDetails | undefined>;
}
