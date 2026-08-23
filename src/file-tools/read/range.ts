export const READ_RANGE_PATTERN = "^([1-9][0-9]*)(?:-([1-9][0-9]*)?)?$";

export type ReadRangeField = "lines" | "pages";

export interface ReadRange {
	readonly start: number;
	readonly end?: number;
}

export type ReadRangeParseResult =
	| { readonly ok: true; readonly value: ReadRange }
	| { readonly ok: false; readonly message: string };

/** 解析从 1 开始、两端包含的单个连续范围。 */
export function parseReadRange(value: string, field: ReadRangeField): ReadRangeParseResult {
	const separator = value.indexOf("-");
	const start = Number(separator === -1 ? value : value.slice(0, separator));
	const endText = separator === -1 ? undefined : value.slice(separator + 1);
	const end = endText === undefined ? start : endText.length === 0 ? undefined : Number(endText);
	if (!positiveSafeInteger(start) || (end !== undefined && !positiveSafeInteger(end))) {
		return invalidSyntax(field);
	}
	if (end !== undefined && start > end) {
		return { ok: false, message: `${field} start must be less than or equal to its end.` };
	}
	return { ok: true, value: { start, ...(end === undefined ? {} : { end }) } };
}

function positiveSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function invalidSyntax(field: ReadRangeField): ReadRangeParseResult {
	return {
		ok: false,
		message: `${field} must be N, N-M, or N- using 1-based safe integers without leading zeros.`,
	};
}
