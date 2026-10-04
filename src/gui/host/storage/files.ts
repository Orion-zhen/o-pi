import { lstat, readdir, realpath } from "node:fs/promises";
import { lstatSync, realpathSync, rmdirSync, unlinkSync, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const missingStorage = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
export const within = (root: string, file: string) => {
	const relative = path.relative(root, file);
	return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const stamp = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const identity = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.mode}`;

export interface StorageTree {
	root: string;
	canonicalRoot: string;
	file: string;
	nodes: { file: string; stamp: string; identity: string; directory: boolean }[];
	version: string;
	bytes: number;
	files: number;
	modified: number;
	blocked: string | null;
}

/** 只读元数据，不跟随条目中的符号链接，也不读取会话或凭据正文。 */
export async function inspectStorageTree(root: string, file: string, signal: AbortSignal): Promise<StorageTree> {
	root = path.resolve(root);
	file = path.resolve(file);
	if (!within(root, file) || root === file) throw new Error("存储条目必须位于管理目录内。");
	const canonicalRoot = await realpath(root);
	const tree: StorageTree = { root, canonicalRoot, file, nodes: [], version: "", bytes: 0, files: 0, modified: 0, blocked: null };
	const hash = createHash("sha256");
	async function visit(target: string): Promise<void> {
		signal.throwIfAborted();
		if (tree.nodes.length >= 50_000) throw new Error("条目超过 50000 个文件或目录，请在文件管理器中处理。");
		const parent = await realpath(path.dirname(target));
		if (parent !== path.join(canonicalRoot, path.relative(root, path.dirname(target)))) throw new Error("目录包含符号链接或已被替换。");
		const info = await lstat(target, { bigint: true });
		const directory = info.isDirectory();
		tree.nodes.push({ file: target, stamp: stamp(info), identity: identity(info), directory });
		hash.update(target).update(stamp(info));
		tree.modified = Math.max(tree.modified, Number(info.mtimeMs));
		if (typeof process.getuid === "function" && info.uid !== BigInt(process.getuid())) {
			tree.blocked = "包含不属于当前用户的内容";
			return;
		}
		if (directory) {
			for (const name of (await readdir(target)).sort()) await visit(path.join(target, name));
		} else if (info.isFile()) {
			tree.bytes += Number(info.size);
			tree.files++;
		} else tree.blocked = "包含符号链接或特殊文件，不支持清理";
	}
	await visit(file);
	tree.version = hash.digest("hex");
	return tree;
}

/** 逐项删除已确认的节点，不递归删除未知文件。检查与提交之间不让出事件循环。 */
export function removeStorageTree(tree: StorageTree): void {
	if (tree.blocked) throw new Error(tree.blocked);
	if (realpathSync(tree.root) !== tree.canonicalRoot) throw new Error("存储目录已变更，请刷新。");
	for (const node of [...tree.nodes].reverse()) {
		const parent = realpathSync(path.dirname(node.file));
		if (parent !== path.join(tree.canonicalRoot, path.relative(tree.root, path.dirname(node.file)))) throw new Error("存储目录已被替换，删除已停止。");
		const info = lstatSync(node.file, { bigint: true });
		// 删除子项会改变目录时间，因此目录只核对身份，rmdir 拒绝删除新增内容。
		if ((node.directory ? identity(info) : stamp(info)) !== (node.directory ? node.identity : node.stamp)) throw new Error("存储条目已被修改，删除已停止。");
		if (node.directory) rmdirSync(node.file);
		else unlinkSync(node.file);
	}
}

export async function storageChildren(root: string, accept: (name: string) => boolean): Promise<string[]> {
	try { return (await readdir(root)).filter(accept).map((name) => path.join(root, name)); }
	catch (error) { if (missingStorage(error)) return []; throw error; }
}
