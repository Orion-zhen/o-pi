import type { AnalysisControl, SyntaxNode } from "../syntax-tree/types.ts";
import type { LanguageExtractor } from "./adapters/types.ts";
import type { CodeCallSite } from "./types.ts";
import type { SourceIndex } from "./source-index.ts";

/** 遍历并投影适配器识别的调用点，只保留精确位置和词法归属。 */
export function extractCallSites(root: SyntaxNode, owners: ReadonlyMap<number, string>, source: SourceIndex,
	call: LanguageExtractor["call"], control: AnalysisControl): CodeCallSite[] {
	const calls: CodeCallSite[] = [];
	const stack: Array<{ node: SyntaxNode; ownerId?: string }> = [{ node: root }];
	for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
		control.check();
		const { node } = current;
		const ownerId = owners.get(node.id) ?? current.ownerId;
		const site = call(node);
		if (site !== undefined) {
			calls.push({
				...source.range(node.startIndex, node.endIndex),
				callee: source.range(site.callee.startIndex, site.callee.endIndex),
				...(site.lookup === undefined ? {} : { lookupByte: source.byteForChar(site.lookup.startIndex) }),
				...(ownerId === undefined ? {} : { ownerId }),
			});
		}
		for (const child of [...node.namedChildren].reverse()) stack.push({ node: child, ...(ownerId === undefined ? {} : { ownerId }) });
	}
	return calls;
}
