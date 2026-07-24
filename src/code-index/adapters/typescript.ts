import type { LanguageAdapterMetadata } from "./types.js";

export const typescriptAdapter: LanguageAdapterMetadata = {
	language: "typescript",
	extensions: [".ts"],
	grammar: { packageName: "tree-sitter-typescript", exportName: "typescript" },
};

export const tsxAdapter: LanguageAdapterMetadata = {
	language: "tsx",
	extensions: [".tsx"],
	grammar: { packageName: "tree-sitter-typescript", exportName: "tsx" },
};
