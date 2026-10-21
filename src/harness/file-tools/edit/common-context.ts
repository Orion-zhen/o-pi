export interface CodePointRange {
	readonly start: number;
	readonly end: number;
}

/** 一次提示生成共用码点和 UTF-16 偏移，避免每个匹配位置重新索引全文。 */
export class EditContextIndex {
	readonly offsets: Uint32Array;
	private readonly points: Uint32Array;

	constructor(text: string) {
		const characters = new Uint32Array(text.length);
		const boundaries = new Uint32Array(text.length + 1);
		let count = 0;
		let offset = 0;
		for (const point of text) {
			characters[count++] = point.codePointAt(0) as number;
			offset += point.length;
			boundaries[count] = offset;
		}
		this.points = characters.subarray(0, count);
		this.offsets = boundaries.subarray(0, count + 1);
	}

	pointIndex(offset: number): number {
		let low = 0;
		let high = this.offsets.length - 1;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if ((this.offsets[middle] as number) < offset) low = middle + 1;
			else high = middle;
		}
		return low;
	}

	requiredRightCounts(range: CodePointRange, ranges: readonly CodePointRange[]): Uint32Array {
		const required = new Uint32Array(range.start + 1);
		const points = this.points;
		// 少量匹配直接比较，大量匹配用 Z 算法一次计算公共上下文。
		const before = ranges.length > 8 ? prefixMatches(points, points.length - range.start, true) : undefined;
		const after = ranges.length > 8 ? prefixMatches(points, range.end, false) : undefined;
		for (const other of ranges) {
			if (other.start === range.start) continue;
			const left = before === undefined ? commonLength(points, range.start - 1, other.start - 1, -1)
				: before[points.length - other.start] ?? 0;
			const right = after === undefined ? commonLength(points, range.end, other.end, 1) : after[other.end] ?? 0;
			required[left] = Math.max(required[left] as number, right + 1);
		}
		for (let left = required.length - 2; left >= 0; left -= 1) {
			required[left] = Math.max(required[left] as number, required[left + 1] as number);
		}
		return required;
	}
}

function commonLength(points: Uint32Array, left: number, right: number, step: -1 | 1): number {
	let count = 0;
	while (left >= 0 && right >= 0 && left < points.length && right < points.length && points[left] === points[right]) {
		count += 1;
		left += step;
		right += step;
	}
	return count;
}

/** Z 算法处理「指定后缀 + 分隔符 + 全文」，分隔符不与任何字符相等。 */
function prefixMatches(points: Uint32Array, pivot: number, reverse: boolean): Uint32Array {
	const prefixLength = points.length - pivot;
	const values = new Uint32Array(prefixLength + 1 + points.length);
	const token = (index: number): number | undefined => {
		if (index === prefixLength) return -1;
		const source = index < prefixLength ? pivot + index : index - prefixLength - 1;
		return points[reverse ? points.length - source - 1 : source];
	};
	let left = 0;
	let right = 0;
	for (let index = 1; index < values.length; index += 1) {
		let count = index < right ? Math.min(right - index, values[index - left] as number) : 0;
		while (index + count < values.length && token(count) === token(index + count)) count += 1;
		values[index] = count;
		if (index + count > right) {
			left = index;
			right = index + count;
		}
	}
	return values.subarray(prefixLength + 1);
}
