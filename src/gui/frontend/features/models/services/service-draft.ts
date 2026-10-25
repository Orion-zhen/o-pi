import { equalConfigValues } from "../../../../../harness/config-values.ts";
import { parseModelsDocument, type ConfigPath, type ModelsDocument } from "../../../../../harness/openai-compatible-provider/document.ts";
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

export function serviceDraftChanged(before: ModelsDocument | undefined, after: ModelsDocument | undefined): boolean {
	return before === undefined || after === undefined
		|| !equalConfigValues(comparableModelsDocument(before), comparableModelsDocument(after));
}
