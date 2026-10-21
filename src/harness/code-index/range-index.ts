interface ByteRange {
	readonly startByte: number;
	readonly endByte: number;
}

interface Node<T> {
	readonly value: T;
	readonly range: ByteRange;
	readonly maxEnd: number;
	readonly left: Node<T> | undefined;
	readonly right: Node<T> | undefined;
}

/** 静态区间索引，用子树最大终点跳过不相交的范围。 */
export class RangeIndex<T> {
	private readonly root: Node<T> | undefined;

	constructor(values: readonly T[], rangeOf: (value: T) => ByteRange) {
		const ordered = values.map((value) => ({ value, range: rangeOf(value) }))
			.sort((a, b) => a.range.startByte - b.range.startByte);
		const build = (start: number, end: number): Node<T> | undefined => {
			if (start >= end) return undefined;
			const middle = (start + end) >>> 1;
			const item = ordered[middle] as (typeof ordered)[number];
			const left = build(start, middle);
			const right = build(middle + 1, end);
			return { ...item, left, right, maxEnd: Math.max(item.range.endByte, left?.maxEnd ?? -1, right?.maxEnd ?? -1) };
		};
		this.root = build(0, ordered.length);
	}

	*intersecting(range: ByteRange): Generator<T> {
		function* visit(node: Node<T> | undefined): Generator<T> {
			if (node === undefined || node.maxEnd < range.startByte) return;
			yield* visit(node.left);
			if (node.range.startByte > range.endByte) return;
			if (node.range.endByte >= range.startByte) yield node.value;
			yield* visit(node.right);
		}
		yield* visit(this.root);
	}
}
