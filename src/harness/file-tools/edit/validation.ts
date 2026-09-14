import { fail, type FileToolError, type ToolOutcome } from "../shared/result.ts";
import { buildEditMatchHints, buildEditNotFoundRecovery } from "./hints.ts";
import { findAll } from "./matches.ts";
import type { EditReplacement } from "./types.ts";

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

interface ProblemDescription extends FileToolError {
	readonly hintsUsed: number;
}

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
	const errors: FileToolError[] = [];
	for (const problem of problems) {
		const budget = problem.kind === "overlap" ? 0 : Math.min(remainingHints, Math.max(1, Math.floor(remainingHints / remainingHintErrors)));
		const { hintsUsed, ...error } = describeProblem(problem, text, replacements, path, budget);
		if (totalErrors === 1) return { status: "failed", error };
		errors.push(error);
		remainingHints -= hintsUsed;
		if (problem.kind !== "overlap") remainingHintErrors -= 1;
	}
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
): ProblemDescription {
	const { index } = problem;
	if (problem.kind === "overlap") {
		return {
			code: "OVERLAPPING_REPLACEMENTS",
			message: `edits[${problem.previous}] and edits[${index}] overlap.`,
			path,
			edit_index: index,
			next: "Merge overlapping replacements against the original content.",
			details: { previous_edit_index: problem.previous },
			hintsUsed: 0,
		};
	}
	if (problem.kind === "missing") return describeMissing(text, problem.replacement.old, replacements.slice(0, index), path, index, budget);
	const { replacement, starts } = problem;
	const hints = buildEditMatchHints(text, replacement.old, replacement.new, starts, budget);
	const summary = hints.length < starts.length ? `${starts.length} locations, ${hints.length} shown` : `${starts.length} locations`;
	return {
		code: "OLD_TEXT_NOT_UNIQUE",
		message: `edits[${index}].old matched ${summary}.`,
		path,
		edit_index: index,
		next: hints.length > 0
			? "Retry with one shown old/new pair; read only if the file changed."
			: "Add unique context to old, or use replace_all for every occurrence.",
		details: { matches: starts.length, shown: hints.length, hints },
		hintsUsed: hints.length,
	};
}

function describeMissing(
	text: string,
	old: string,
	previous: readonly EditReplacement[],
	path: string,
	index: number,
	hintLimit: number,
): ProblemDescription {
	const recovery = buildEditNotFoundRecovery(text, old, previous, hintLimit);
	const base = { code: "OLD_TEXT_NOT_FOUND", path, edit_index: index } as const;
	switch (recovery.kind) {
		case "dependent":
			return {
				...base,
				message: `edits[${index}].old is absent from the original file, but appears after edits[${recovery.afterEditIndex}].`,
				next: `Rewrite edits[${index}] against the original content, or merge the dependent changes into one replacement.`,
				details: { reason: "dependent_edit", after_edit_index: recovery.afterEditIndex },
				hintsUsed: 0,
			};
		case "format":
			return {
				...base,
				message: `edits[${index}].old was not found exactly; one formatting-equivalent candidate exists.`,
				next: "Retry with the shown old text, adapting new if needed; read only if the file changed.",
				details: { reason: "format_drift", candidates: [recovery.candidate] },
				hintsUsed: 1,
			};
		case "anchors": {
			const shown = recovery.candidates.length;
			return {
				...base,
				message: `edits[${index}].old was not found in the original file; ${shown} nearby ${shown === 1 ? "candidate" : "candidates"} shown.`,
				next: `Rewrite edits[${index}].old using a matching candidate, or read the file if none is correct.`,
				details: { reason: "anchor_candidates", shown, candidates: recovery.candidates },
				hintsUsed: shown,
			};
		}
		case "none":
			return {
				...base,
				message: `edits[${index}].old was not found in the original file.`,
				next: "Refine your edit and try again.",
				hintsUsed: 0,
			};
	}
}
