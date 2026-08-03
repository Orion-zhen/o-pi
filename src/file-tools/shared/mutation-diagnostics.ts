import type { TargetRef } from "../../filesystem/contracts/path.js";
import type { DiagnosticSnapshot, DiagnosticsSummary } from "./diagnostics.js";

export interface MutationLineRange {
	startLine: number;
	endLine: number;
}

/** 所有文件 mutation 共用的尽力而为诊断生命周期。 */
export interface MutationDiagnosticsSource {
	beforeMutation(input: {
		readonly target: TargetRef;
		readonly signal?: AbortSignal;
	}): Promise<DiagnosticSnapshot | undefined>;
	afterMutation(input: {
		readonly target: TargetRef;
		readonly content: string;
		readonly created: boolean;
		readonly changedRanges?: readonly MutationLineRange[];
		readonly baseline?: DiagnosticSnapshot;
		readonly signal?: AbortSignal;
	}): Promise<DiagnosticsSummary | undefined>;
}

export async function captureMutationDiagnostics(
	source: MutationDiagnosticsSource | undefined,
	target: TargetRef,
	signal: AbortSignal | undefined,
): Promise<DiagnosticSnapshot | undefined> {
	try {
		return await source?.beforeMutation({ target, ...(signal === undefined ? {} : { signal }) });
	} catch {
		return undefined;
	}
}

export async function collectMutationDiagnostics(
	source: MutationDiagnosticsSource | undefined,
	input: Parameters<MutationDiagnosticsSource["afterMutation"]>[0],
): Promise<DiagnosticsSummary | undefined> {
	try {
		return await source?.afterMutation(input);
	} catch {
		return undefined;
	}
}
