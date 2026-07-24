import type { LanguageAdapterMetadata } from "./types.js";

export const javascriptAdapter: LanguageAdapterMetadata = {
	language: "javascript",
	extensions: [".js", ".mjs", ".cjs"],
	grammar: { packageName: "tree-sitter-javascript" },
};

export const jsxAdapter: LanguageAdapterMetadata = {
	language: "jsx",
	extensions: [".jsx"],
	grammar: { packageName: "tree-sitter-javascript" },
};
