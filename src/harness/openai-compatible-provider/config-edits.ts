import { applyEdits, modify } from "jsonc-parser";
import { emptyModelsDocument, parseModelsDocument, type ConfigPath } from "./document.ts";
import { modelCandidateEdits, type ModelCandidate } from "./model-candidates.ts";

export function editModelsDocument(content: string, path: ConfigPath, value: unknown): string {
	const source = content || emptyModelsDocument;
	return applyEdits(source, modify(source, path, value, {
		formattingOptions: { insertSpaces: false, tabSize: 4 },
	}));
}

/** 只补全已有服务中的模型，逐字段更新以保留注释。 */
export function completeProviderModels(content: string, id: string, candidates: ModelCandidate[]): string {
	const provider = parseModelsDocument(content || emptyModelsDocument).providers[id];
	if (!provider) return content;
	for (const { path, value } of modelCandidateEdits(provider, candidates)) {
		content = editModelsDocument(content, ["providers", id, ...path], value);
	}
	return content;
}

/** 字段修改与候选补全在同一次草稿更新中完成。 */
export function editProviderField(content: string, id: string, path: ConfigPath, value: unknown, candidates: ModelCandidate[]): string {
	const edited = editModelsDocument(content, ["providers", id, ...path], value);
	return completeProviderModels(edited, id, candidates);
}
