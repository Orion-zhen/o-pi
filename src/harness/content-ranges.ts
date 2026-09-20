const RANGE = "[1-9][0-9]*(?:-(?:[1-9][0-9]*)?)?";
export const READ_RANGE_PATTERN = `^${RANGE}(?:,${RANGE})*$`;

export type ReadRangeField = "lines" | "pages";

export interface ReadRange {
	readonly start: number;
	readonly end?: number;
}

export interface ResolvedReadRange {
	readonly start: number;
	readonly end: number;
}

export type ReadRangesParseResult =
	| { readonly ok: true; readonly value: readonly ReadRange[] }
	| { readonly ok: false; readonly message: string };

/** 语法由工具 schema 约束，这里校验数值与区间方向。 */
export function parseReadRanges(value: string, field: ReadRangeField): ReadRangesParseResult {
	const ranges: ReadRange[] = [];
	for (const part of value.split(",")) {
		const separator = part.indexOf("-");
		const start = Number(separator === -1 ? part : part.slice(0, separator));
		const endText = separator === -1 ? undefined : part.slice(separator + 1);
		const end = endText === undefined ? start : endText.length === 0 ? undefined : Number(endText);
		if (!positiveSafeInteger(start) || (end !== undefined && !positiveSafeInteger(end))) {
			return { ok: false, message: `${field} must use 1-based safe integers.` };
		}
		if (end !== undefined && start > end) {
			return { ok: false, message: `${field} start must be less than or equal to its end.` };
		}
		ranges.push({ start, ...(end === undefined ? {} : { end }) });
	}
	return { ok: true, value: ranges };
}

export function mergeReadRanges(ranges: readonly ResolvedReadRange[]): ResolvedReadRange[] {
	const merged: ResolvedReadRange[] = [];
	for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
		const previous = merged.at(-1);
		if (previous === undefined || range.start > previous.end + 1) merged.push(range);
		else merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
	}
	return merged;
}

export function formatReadRanges(ranges: readonly ReadRange[]): string {
	return ranges.map(({ start, end }) => end === start ? String(start) : `${start}-${end ?? ""}`).join(",");
}

function positiveSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}
