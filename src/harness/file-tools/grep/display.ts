const DISPLAY_CODE_POINT_LIMIT = 240;

/** 在 Unicode code point 边界围绕相关位置截取单行证据。 */
export function compactDisplayLine(
	text: string,
	focusStart = 0,
	focusEnd = focusStart,
	limit = DISPLAY_CODE_POINT_LIMIT,
): string {
	const points = [...text];
	if (points.length <= limit) return text;
	const start = codePointOffset(text, focusStart);
	const end = Math.max(start, codePointOffset(text, focusEnd));
	const focusMiddle = Math.floor((start + end) / 2);
	let sliceStart = Math.max(0, focusMiddle - Math.floor((limit - 6) / 2));
	let sliceEnd = Math.min(points.length, sliceStart + limit - 6);
	if (sliceEnd - sliceStart < limit - 6) sliceStart = Math.max(0, sliceEnd - (limit - 6));
	const prefix = sliceStart > 0 ? "..." : "";
	const suffix = sliceEnd < points.length ? "..." : "";
	const available = limit - [...prefix, ...suffix].length;
	if (sliceEnd - sliceStart > available) {
		const excess = sliceEnd - sliceStart - available;
		sliceStart += Math.floor(excess / 2);
		sliceEnd -= Math.ceil(excess / 2);
	} else {
		let remaining = available - (sliceEnd - sliceStart);
		const growLeft = Math.min(sliceStart, Math.floor(remaining / 2));
		sliceStart -= growLeft;
		remaining -= growLeft;
		const growRight = Math.min(points.length - sliceEnd, remaining);
		sliceEnd += growRight;
		remaining -= growRight;
		sliceStart -= Math.min(sliceStart, remaining);
	}
	return `${prefix}${points.slice(sliceStart, sliceEnd).join("")}${suffix}`;
}

export function firstTermFocus(text: string, terms: readonly string[]): { readonly start: number; readonly end: number } {
	const lower = text.toLocaleLowerCase();
	let best: { readonly start: number; readonly end: number } | undefined;
	for (const term of terms) {
		const start = lower.indexOf(term.toLocaleLowerCase());
		if (start < 0) continue;
		const candidate = { start, end: start + term.length };
		if (best === undefined || candidate.start < best.start || (candidate.start === best.start && candidate.end > best.end)) best = candidate;
	}
	return best ?? { start: 0, end: 0 };
}

function codePointOffset(text: string, utf16Offset: number): number {
	return [...text.slice(0, Math.max(0, Math.min(text.length, utf16Offset)))].length;
}
