import type { LanguageAdapterMetadata } from "./types.js";

export const rustAdapter: LanguageAdapterMetadata = {
	language: "rust",
	extensions: [".rs"],
	grammar: { packageName: "tree-sitter-rust" },
};
