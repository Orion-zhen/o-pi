import { completeProviderModels } from "../../../../../harness/openai-compatible-provider/config-edits.ts";
import { emptyModelsDocument, parseModelsDocument, type ConfigPath, type ModelsDocument } from "../../../../../harness/openai-compatible-provider/document.ts";
import type { ModelCandidate } from "../../../../../harness/openai-compatible-provider/model-candidates.ts";
import { comparableModelsDocument } from "../../../../../harness/openai-compatible-provider/settings-view.ts";

export type ChangeConfig = (path: ConfigPath, value: unknown) => void;
export type ChangeDraft = (update: (content: string) => string) => void;

export function parseServiceDraft(content: string) {
	try {
		return { value: parseModelsDocument(content), error: "" };
	} catch (error) {
		return { value: undefined, error: error instanceof Error ? error.message : String(error) };
	}
}

export function receiveServiceCandidates(content: string, id: string, candidates: ModelCandidate[]): string {
	// 候选晚于源码输入到达时，不覆盖尚未完成的 JSON。
	if (!parseServiceDraft(content || emptyModelsDocument).value) return content;
	return completeProviderModels(content, id, candidates);
}

export function serviceDraftChanged(original: string, draft: string): boolean {
	if (original === draft) return false;
	let before: ModelsDocument;
	let after: ModelsDocument;
	try {
		before = parseModelsDocument(original || emptyModelsDocument);
		after = parseModelsDocument(draft || emptyModelsDocument);
	} catch {
		// 非法 JSON 仍是待保存草稿，由设置页阻止保存。
		return true;
	}
	return comparableModelsDocument(before) !== comparableModelsDocument(after);
}
