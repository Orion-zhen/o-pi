import { realpath } from "node:fs/promises";
import path from "node:path";

const inside = (root: string, target: string) => {
	const relative = path.relative(root, target);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		throw new Error("文件路径超出当前工作区。");
};

export async function workspacePath(cwd: string, name: string, missing = false): Promise<string> {
	if (path.isAbsolute(name)) throw new Error("文件路径必须相对当前工作区。");
	const root = await realpath(cwd);
	const target = path.resolve(root, name);
	inside(root, target);
	let existing = target;
	for (;;) {
		try {
			const resolved = await realpath(existing);
			inside(root, resolved);
			return path.resolve(resolved, path.relative(existing, target));
		} catch (error) {
			if (!missing || !(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			existing = path.dirname(existing);
		}
	}
}
