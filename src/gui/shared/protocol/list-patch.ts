export type ListPatch<T> = ({ from: number; count: number } | { values: T[] })[];

/** 复用旧目录的连续区间，只发送新增或修改的记录，仍保留原始顺序。 */
export function diffList<T extends { path: string }>(before: T[], after: T[]): ListPatch<T> | undefined {
	if (before === after) return undefined;
	const previous = new Map(before.map((value, index) => [value.path, { value, index }]));
	const parts: ListPatch<T> = [];
	let changed = before.length !== after.length;
	for (const [index, value] of after.entries()) {
		const old = previous.get(value.path);
		const last = parts.at(-1);
		if (old && (old.value === value || JSON.stringify(old.value) === JSON.stringify(value))) {
			if (last && "from" in last && last.from + last.count === old.index) last.count++;
			else parts.push({ from: old.index, count: 1 });
			if (old.index !== index) changed = true;
		} else {
			if (last && "values" in last) last.values.push(value);
			else parts.push({ values: [value] });
			changed = true;
		}
	}
	return changed ? parts : undefined;
}

export function applyList<T>(before: T[], patch: ListPatch<T>): T[] {
	return patch.flatMap((part) => "values" in part ? part.values : before.slice(part.from, part.from + part.count));
}
