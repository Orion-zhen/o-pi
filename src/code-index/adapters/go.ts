import type { LanguageAdapterMetadata } from "./types.js";

export const goAdapter: LanguageAdapterMetadata = {
	language: "go",
	extensions: [".go"],
	grammar: { packageName: "tree-sitter-go" },
};
