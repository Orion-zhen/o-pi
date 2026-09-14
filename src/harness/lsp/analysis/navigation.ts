import type { CallHierarchyIncomingCall, Location, Range } from "vscode-languageserver-protocol";
import type { CodeNavigation, IndexedCodeUnit } from "../../code-index/types.ts";
import { fileUriToPath, workspaceRelativePath } from "../protocol/uri.ts";
import { waitUnlessAborted } from "./deadline.ts";
import type { LspCodeAnalysisInput } from "./code-analysis.ts";

/** 复用关系响应和受控快照，不发送额外 LSP 请求。 */
export async function relationNavigation(
	input: LspCodeAnalysisInput & { readonly signal: AbortSignal },
	unit: IndexedCodeUnit,
	calls: readonly CallHierarchyIncomingCall[],
	references: readonly Location[],
): Promise<CodeNavigation[]> {
	const candidates = [
		...calls.flatMap((call) => call.fromRanges.map((range) => ({ kind: "caller" as const, uri: call.from.uri, range }))),
		...references.map((reference) => ({ kind: "reference" as const, ...reference })),
	].flatMap(({ kind, uri, range }) => {
		const filePath = fileUriToPath(uri);
		const path = filePath === undefined ? undefined : workspaceRelativePath(input.root, filePath);
		if (path === undefined || !validRange(range)) return [];
		const line = range.start.line + 1;
		if (path === unit.path && line >= unit.startLine && line <= unit.endLine) return [];
		return [{ kind, path, line, column: range.start.character + 1 }];
	}).sort((left, right) => Number(left.kind === "reference") - Number(right.kind === "reference")
		|| (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
		|| left.line - right.line || left.column - right.column);
	const seen = new Set<string>();
	const result: CodeNavigation[] = [];
	let inspected = 0;
	for (const candidate of candidates) {
		const key = `${candidate.path}\0${candidate.line}\0${candidate.column}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (inspected++ >= 16 || input.signal.aborted) break;
		const document = await waitUnlessAborted(input.load(candidate.path), input.signal);
		const text = document?.text.split(/\r?\n/u)[candidate.line - 1];
		if (text === undefined || candidate.column > text.length) continue;
		result.push(candidate);
		if (result.length === 2) break;
	}
	return result;
}

function validRange(range: Range): boolean {
	return [range.start.line, range.start.character, range.end.line, range.end.character]
		.every((value) => Number.isSafeInteger(value) && value >= 0)
		&& (range.end.line > range.start.line
			|| range.end.line === range.start.line && range.end.character > range.start.character);
}
