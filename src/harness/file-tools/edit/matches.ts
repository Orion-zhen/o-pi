export function findAll(text: string, needle: string): number[] {
	const starts: number[] = [];
	let cursor = 0;
	while (cursor <= text.length - needle.length) {
		const found = text.indexOf(needle, cursor);
		if (found === -1) break;
		starts.push(found);
		cursor = found + Math.max(needle.length, 1);
	}
	return starts;
}
