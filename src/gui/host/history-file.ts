import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 历史修改仅接受共享目录中的普通文件，返回身份信息供并发修改检查。 */
export async function inspectHistoryFile(file: string) {
	const root = await realpath(path.join(getAgentDir(), "sessions"));
	const parent = await realpath(path.dirname(file));
	const relative = path.relative(root, parent);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		throw new Error("会话文件位于共享历史目录之外。");
	const info = await lstat(file, { bigint: true });
	if (!info.isFile()) throw new Error("只允许修改普通会话文件，不允许符号链接。");
	return { parent, dev: info.dev, ino: info.ino, size: info.size, mtime: info.mtimeNs, ctime: info.ctimeNs };
}
