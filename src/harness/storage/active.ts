import path from "node:path";

const active = new Set<{ file: string }>();

/** 每个持有者独立登记，释放时不影响同一路径的其他占用。 */
export function retainStoragePath(file: string): () => void {
	const entry = { file: path.resolve(file) };
	active.add(entry);
	return () => { active.delete(entry); };
}

export function storagePathInUse(file: string): boolean {
	const target = path.resolve(file);
	return [...active].some(({ file }) => {
		const relative = path.relative(target, file);
		return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
	});
}
