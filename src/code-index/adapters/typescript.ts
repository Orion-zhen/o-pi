import { javascriptAdapter } from "./javascript.js";
import type { LanguageAdapter } from "./types.js";

export const typescriptAdapter: LanguageAdapter = {
	language: "typescript",
	extensions: [".ts"],
	grammar: { packageName: "tree-sitter-typescript", exportName: "typescript" },
	extractUnits: javascriptAdapter.extractUnits,
	extractImports: javascriptAdapter.extractImports,
};

export const tsxAdapter: LanguageAdapter = {
	language: "tsx",
	extensions: [".tsx"],
	grammar: { packageName: "tree-sitter-typescript", exportName: "tsx" },
	extractUnits: javascriptAdapter.extractUnits,
	extractImports: javascriptAdapter.extractImports,
};
