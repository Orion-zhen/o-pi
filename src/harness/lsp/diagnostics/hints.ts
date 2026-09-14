import { CodeAction, CodeActionRequest, type Diagnostic, type TextEdit } from "vscode-languageserver-protocol";
import type { LspFeatureSession } from "../protocol/features.js";
import type { LspErrorDiagnostic, LspRequestOptions } from "../types.js";

/** 只展示唯一、已解析、单文件 quickfix 的标题，不执行编辑或命令。 */
export async function diagnosticHints(
	session: LspFeatureSession,
	uri: string,
	diagnostics: readonly Diagnostic[],
	errors: readonly LspErrorDiagnostic[],
	options: Required<LspRequestOptions>,
): Promise<readonly (string | undefined)[]> {
	const provider = session.capabilities()?.codeActionProvider;
	if (provider === undefined || provider === false) return [];
	const deadline = Date.now() + options.timeoutMs;
	const hints: Array<string | undefined> = [];
	let requested = 0;
	for (const [index, item] of errors.entries()) {
		const matching = diagnostics.filter((diagnostic) => diagnostic.range.start.line === item.line - 1
			&& diagnostic.range.start.character === item.column - 1);
		const diagnostic = matching[0];
		const timeoutMs = deadline - Date.now();
		if (diagnostic === undefined) continue;
		if (requested >= 3 || timeoutMs <= 0 || options.signal.aborted) break;
		requested += 1;
		const actions = await session.request(CodeActionRequest.type, {
			textDocument: { uri }, range: diagnostic.range,
			context: { diagnostics: matching, only: ["quickfix"] },
		}, { ...options, timeoutMs });
		const candidates = (actions ?? []).flatMap((action) => {
			if (!CodeAction.is(action) || action.disabled !== undefined || action.command !== undefined
				|| !(action.kind === "quickfix" || action.kind?.startsWith("quickfix.") === true)
				|| !simpleEdit(action, uri)) return [];
			const title = action.title.replace(/\s+/gu, " ").trim();
			return title.length === 0 || [...title].length > 160 ? [] : [title];
		});
		if (candidates.length === 1) hints[index] = candidates[0];
	}
	return hints;
}

function simpleEdit(action: CodeAction, uri: string): boolean {
	const edit = action.edit;
	if (edit === undefined) return false;
	const edits: TextEdit[] = [];
	for (const [target, changes] of Object.entries(edit.changes ?? {})) {
		if (target !== uri) return false;
		edits.push(...changes);
	}
	for (const change of edit.documentChanges ?? []) {
		if (!("textDocument" in change) || change.textDocument.uri !== uri) return false;
		for (const textEdit of change.edits) {
			if (!("newText" in textEdit)) return false;
			edits.push(textEdit);
		}
	}
	return edits.length > 0 && edits.length <= 4
		&& edits.every((value) => value.newText.length <= 2048);
}
