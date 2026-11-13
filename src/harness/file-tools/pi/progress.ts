import type { LspDiagnosticsSummary as DiagnosticsSummary } from "../../lsp/types.ts";

export type MutationLspProgressStatus = "pending" | "running" | DiagnosticsSummary["status"];

export interface MutationLspProgress {
	status: MutationLspProgressStatus;
	errors: number;
	warnings: number;
}

interface MutationContentProgressDetails {
	status: "editing" | "writing";
	diff?: string;
	replacements?: number;
}

export interface MutationPostProcessProgressDetails {
	status: "post-processing";
	diff?: string;
	replacements?: number;
	lsp: MutationLspProgress;
}

export type MutationProgressDetails = MutationContentProgressDetails | MutationPostProcessProgressDetails;

export interface MutationProgressResult {
	content: [];
	details: MutationProgressDetails;
}

export type MutationProgressCallback = (result: MutationProgressResult) => void;

export interface MutationPostProcessObserver {
	lspStarted(): void;
	lspCompleted(diagnostics: DiagnosticsSummary | undefined): void;
}

interface MutationProgressContext {
	diff?: string;
	replacements?: number;
}

interface MutationProgressObserver extends MutationPostProcessObserver {
	prepared(details: MutationContentProgressDetails): void;
}

/** 进度通知只在适配边界隔离异常，不影响文件提交和诊断。 */
export function createMutationProgress(onUpdate: MutationProgressCallback | undefined): MutationProgressObserver {
	let context: MutationProgressContext = {};
	const emit = (details: MutationProgressDetails): void => {
		try {
			onUpdate?.({ content: [], details });
		} catch {}
	};
	return {
		prepared(details) {
			const { status: _status, ...preview } = details;
			context = preview;
			emit(details);
		},
		lspStarted() {
			emit({ status: "post-processing", ...context, lsp: { status: "running", errors: 0, warnings: 0 } });
		},
		lspCompleted(diagnostics) {
			const lsp: MutationLspProgress = diagnostics === undefined
				? { status: "unavailable", errors: 0, warnings: 0 }
				: { status: diagnostics.status, errors: diagnostics.file_errors, warnings: diagnostics.file_warnings };
			emit({ status: "post-processing", ...context, lsp });
		},
	};
}

export function isMutationProgress(value: unknown): value is MutationProgressDetails {
	if (!isRecord(value) || !hasCommonProgress(value)) return false;
	if (value["status"] === "editing" || value["status"] === "writing") return true;
	if (value["status"] !== "post-processing" || !isRecord(value["lsp"])) return false;
	const lsp = value["lsp"];
	return isLspStatus(lsp["status"])
		&& typeof lsp["errors"] === "number"
		&& typeof lsp["warnings"] === "number";
}

function hasCommonProgress(value: Record<string, unknown>): boolean {
	return (value["diff"] === undefined || typeof value["diff"] === "string")
		&& (value["replacements"] === undefined || typeof value["replacements"] === "number");
}

function isLspStatus(value: unknown): value is MutationLspProgressStatus {
	return value === "pending" || value === "running" || value === "clean" || value === "warnings"
		|| value === "errors" || value === "unavailable" || value === "timeout";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
