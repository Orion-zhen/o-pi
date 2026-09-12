import { fail, type FailedResult, type FileToolError, type ToolOutcome } from "../shared/result.js";
import { buildEditMatchHints, buildEditNotFoundRecovery } from "./hints.js";
import { findAll } from "./matches.js";
import type { EditReplacement } from "./types.js";

const MAX_REPORTED_ERRORS = 8;

export interface EditMatch {
	readonly index: number;
	readonly start: number;
	readonly end: number;
	readonly replacement: EditReplacement;
}

type MatchProblem =
	| { readonly kind: "missing"; readonly index: number; readonly replacement: EditReplacement }
	| { readonly kind: "ambiguous"; readonly index: number; readonly replacement: EditReplacement; readonly starts: readonly number[] }
	| { readonly kind: "overlap"; readonly index: number; readonly previous: number };

/** 检查同一原文上的全部替换。错误数量与恢复候选分别使用共享预算。 */
export function validateReplacements(
	text: string,
	replacements: readonly EditReplacement[],
	path: string,
	hintLimit: number,
): ToolOutcome<readonly EditMatch[]> {
	const matches: EditMatch[] = [];
	const problems: MatchProblem[] = [];
	let totalErrors = 0;
	const record = (problem: MatchProblem) => {
		totalErrors += 1;
		if (problems.length < MAX_REPORTED_ERRORS) problems.push(problem);
	};
	for (const [index, replacement] of replacements.entries()) {
		const starts = findAll(text, replacement.old);
		if (starts.length === 0) record({ kind: "missing", index, replacement });
		else if (starts.length > 1 && replacement.replace_all !== true) record({ kind: "ambiguous", index, replacement, starts });
		else for (const start of starts) matches.push({ index, start, end: start + replacement.old.length, replacement });
	}
	matches.sort((left, right) => left.start - right.start || left.index - right.index);
	let enclosing: EditMatch | undefined;
	const reportedPairs = new Set<string>();
	for (const match of matches) {
		if (enclosing !== undefined && match.start < enclosing.end) {
			const key = [enclosing.index, match.index].sort((a, b) => a - b).join(":");
			if (!reportedPairs.has(key)) {
				reportedPairs.add(key);
				record({ kind: "overlap", index: match.index, previous: enclosing.index });
			}
		}
		if (enclosing === undefined || match.end > enclosing.end) enclosing = match;
	}
	if (totalErrors === 0) return matches;

	let remainingHints = hintLimit;
	let remainingHintErrors = problems.filter((problem) => problem.kind !== "overlap").length;
	const errors = problems.map((problem) => {
		const budget = problem.kind === "overlap" ? 0 : Math.min(remainingHints, Math.max(1, Math.floor(remainingHints / remainingHintErrors)));
		const error = describeProblem(problem, text, replacements, path, budget).error;
		remainingHints -= hintCount(error);
		if (problem.kind !== "overlap") remainingHintErrors -= 1;
		return error;
	});
	const first = errors[0];
	if (totalErrors === 1 && first !== undefined) return { status: "failed", error: first };
	return fail("EDIT_VALIDATION_FAILED", `${totalErrors} edit errors, ${errors.length} shown. No changes applied.`, {
		path,
		errors,
		details: { total_errors: totalErrors, shown_errors: errors.length },
	});
}

function describeProblem(
	problem: MatchProblem,
	text: string,
	replacements: readonly EditReplacement[],
	path: string,
	budget: number,
): FailedResult {
	const { index } = problem;
	if (problem.kind === "overlap") {
		return fail("OVERLAPPING_REPLACEMENTS", `edits[${problem.previous}] and edits[${index}] overlap.`, {
			path,
			edit_index: index,
			next: "Merge overlapping replacements against the original content.",
			details: { previous_edit_index: problem.previous },
		});
	}
	if (problem.kind === "missing") return notFoundFailure(text, problem.replacement.old, replacements.slice(0, index), path, index, budget);
	const { replacement, starts } = problem;
	const hints = buildEditMatchHints(text, replacement.old, replacement.new, starts, budget);
	const summary = hints.length < starts.length ? `${starts.length} locations, ${hints.length} shown` : `${starts.length} locations`;
	return fail("OLD_TEXT_NOT_UNIQUE", `edits[${index}].old matched ${summary}.`, {
		path,
		edit_index: index,
		next: hints.length > 0
			? "Retry with one shown old/new pair; read only if the file changed."
			: "Add unique context to old, or use replace_all for every occurrence.",
		details: { matches: starts.length, shown: hints.length, hints },
	});
}

function hintCount(error: FileToolError): number {
	const details = error.details;
	if (Array.isArray(details?.["hints"])) return details["hints"].length;
	if (Array.isArray(details?.["candidates"])) return details["candidates"].length;
	return 0;
}

function notFoundFailure(
	text: string,
	old: string,
	previous: readonly EditReplacement[],
	path: string,
	index: number,
	hintLimit: number,
): FailedResult {
	const recovery = buildEditNotFoundRecovery(text, old, previous, hintLimit);
	switch (recovery.kind) {
		case "dependent":
			return fail("OLD_TEXT_NOT_FOUND", `edits[${index}].old is absent from the original file, but appears after edits[${recovery.afterEditIndex}].`, {
				path,
				edit_index: index,
				next: `Rewrite edits[${index}] against the original content, or merge the dependent changes into one replacement.`,
				details: { reason: "dependent_edit", after_edit_index: recovery.afterEditIndex },
			});
		case "format":
			return fail("OLD_TEXT_NOT_FOUND", `edits[${index}].old was not found exactly; one formatting-equivalent candidate exists.`, {
				path,
				edit_index: index,
				next: "Retry with the shown old text, adapting new if needed; read only if the file changed.",
				details: { reason: "format_drift", candidates: [recovery.candidate] },
			});
		case "anchors": {
			const shown = recovery.candidates.length;
			return fail("OLD_TEXT_NOT_FOUND", `edits[${index}].old was not found in the original file; ${shown} nearby ${shown === 1 ? "candidate" : "candidates"} shown.`, {
				path,
				edit_index: index,
				next: `Rewrite edits[${index}].old using a matching candidate, or read the file if none is correct.`,
				details: { reason: "anchor_candidates", shown, candidates: recovery.candidates },
			});
		}
		case "none":
			return fail("OLD_TEXT_NOT_FOUND", `edits[${index}].old was not found in the original file.`, {
				path,
				edit_index: index,
				next: "Refine your edit and try again.",
			});
	}
}
