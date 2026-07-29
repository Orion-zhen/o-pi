import type { TargetRef } from "../../filesystem/contracts/path.js";
import type { DiagnosticsSummary } from "../shared/diagnostics.js";

export interface WriteDiagnosticsSource {
	afterWrite(input: {
		readonly target: TargetRef;
		readonly content: string;
		readonly created: boolean;
		readonly signal?: AbortSignal;
	}): Promise<DiagnosticsSummary | undefined>;
}
