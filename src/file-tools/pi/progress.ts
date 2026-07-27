import type { DiagnosticsSummary, DiagnosticStatus } from "../shared/diagnostics.js";

export type MutationLspProgressStatus = "pending" | "running" | DiagnosticStatus;
export type MutationRepoMapProgressStatus = "pending" | "running" | "updated" | "partially_stale" | "inactive" | "unavailable";

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
	repo_map: MutationRepoMapProgressStatus;
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
	lspUnavailable(): void;
	repoMapStarted(): void;
	repoMapCompleted(status: "updated" | "partially_stale" | undefined): void;
	repoMapUnavailable(): void;
}

interface MutationProgressContext {
	diff?: string;
	replacements?: number;
}

export function mutationProgress(details: MutationProgressDetails): MutationProgressResult {
	return { content: [], details };
}

export function createMutationPostProcessObserver(
	onUpdate: MutationProgressCallback | undefined,
	context: () => MutationProgressContext,
): MutationPostProcessObserver {
	let lsp: MutationLspProgress = { status: "pending", errors: 0, warnings: 0 };
	let repoMap: MutationRepoMapProgressStatus = "pending";
	const emit = (): void => {
		if (onUpdate === undefined) return;
		try {
			onUpdate(mutationProgress({
				status: "post-processing",
				...context(),
				lsp: { ...lsp },
				repo_map: repoMap,
			}));
		} catch {}
	};
	return {
		lspStarted() {
			lsp = { status: "running", errors: 0, warnings: 0 };
			emit();
		},
		lspCompleted(diagnostics) {
			lsp = diagnostics === undefined
				? { status: "unavailable", errors: 0, warnings: 0 }
				: { status: diagnostics.status, errors: diagnostics.file_errors, warnings: diagnostics.file_warnings };
			emit();
		},
		lspUnavailable() {
			lsp = { status: "unavailable", errors: 0, warnings: 0 };
			emit();
		},
		repoMapStarted() {
			repoMap = "running";
			emit();
		},
		repoMapCompleted(status) {
			repoMap = status ?? "inactive";
			emit();
		},
		repoMapUnavailable() {
			repoMap = "unavailable";
			emit();
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
		&& typeof lsp["warnings"] === "number"
		&& isRepoMapStatus(value["repo_map"]);
}

function hasCommonProgress(value: Record<string, unknown>): boolean {
	return (value["diff"] === undefined || typeof value["diff"] === "string")
		&& (value["replacements"] === undefined || typeof value["replacements"] === "number");
}

function isLspStatus(value: unknown): value is MutationLspProgressStatus {
	return value === "pending" || value === "running" || value === "clean" || value === "warnings"
		|| value === "errors" || value === "unavailable" || value === "timeout";
}

function isRepoMapStatus(value: unknown): value is MutationRepoMapProgressStatus {
	return value === "pending" || value === "running" || value === "updated" || value === "partially_stale"
		|| value === "inactive" || value === "unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
