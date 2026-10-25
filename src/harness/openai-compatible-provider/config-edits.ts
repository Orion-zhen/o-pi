import { applyEdits, modify } from "jsonc-parser";
import { emptyModelsDocument, type ConfigPath } from "./document.ts";

export function editModelsDocument(content: string, path: ConfigPath, value: unknown): string {
	const source = content || emptyModelsDocument;
	return applyEdits(source, modify(source, path, value, {
		formattingOptions: { insertSpaces: false, tabSize: 4 },
	}));
}
