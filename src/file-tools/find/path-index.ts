import type { FindMatch } from "../types.js";

/** 路径 trie 节点；折叠 find 结果时统计 descendant 文件/目录数和最高相关性排名。 */
export interface PathIndexNode {
	name: string;
	path: string;
	children: Map<string, PathIndexNode>;
	entryKind?: FindMatch["kind"];
	descendantFileCount: number;
	descendantDirectoryCount: number;
	bestRank: number;
}

/** 根据已按相关性排序的结果创建 trie；rank 越小表示相关性越高。 */
export function createPathIndex(matches: FindMatch[]): PathIndexNode {
	const root: PathIndexNode = {
		name: "",
		path: ".",
		children: new Map(),
		descendantFileCount: 0,
		descendantDirectoryCount: 0,
		bestRank: Number.POSITIVE_INFINITY,
	};
	for (let rank = 0; rank < matches.length; rank += 1) addPath(root, matches[rank], rank);
	return root;
}

/** 子节点按最高排名 descendant 排序，同分再按路径稳定排序。 */
export function sortedChildren(node: PathIndexNode): PathIndexNode[] {
	return Array.from(node.children.values()).sort(compareNodeRank);
}

function addPath(root: PathIndexNode, match: FindMatch | undefined, rank: number): void {
	if (match === undefined) return;
	const parts = match.path.split("/").filter((part) => part.length > 0);
	let node = root;
	increment(node, match.kind, rank);
	for (const part of parts) {
		let child = node.children.get(part);
		if (child === undefined) {
			child = {
				name: part,
				path: node.path === "." ? part : `${node.path}/${part}`,
				children: new Map(),
				descendantFileCount: 0,
				descendantDirectoryCount: 0,
				bestRank: Number.POSITIVE_INFINITY,
			};
			node.children.set(part, child);
		}
		increment(child, match.kind, rank);
		node = child;
	}
	node.entryKind = match.kind;
}

function increment(node: PathIndexNode, kind: FindMatch["kind"], rank: number): void {
	if (kind === "file") node.descendantFileCount += 1;
	else node.descendantDirectoryCount += 1;
	node.bestRank = Math.min(node.bestRank, rank);
}

function compareNodeRank(left: PathIndexNode, right: PathIndexNode): number {
	const rank = left.bestRank - right.bestRank;
	if (rank !== 0) return rank;
	return compareStableString(left.path, right.path);
}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
