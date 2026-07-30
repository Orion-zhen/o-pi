import { javascriptAdapter } from "./javascript.js";
import { TREE_SITTER_GRAMMARS } from "../../syntax-tree/grammars.js";
import type { LanguageAdapter } from "./types.js";

export const typescriptAdapter: LanguageAdapter = {
	language: "typescript",
	extensions: [".ts"],
	grammar: TREE_SITTER_GRAMMARS.typescript,
	extractUnits: javascriptAdapter.extractUnits,
	extractImports: javascriptAdapter.extractImports,
};

export const tsxAdapter: LanguageAdapter = {
	language: "tsx",
	extensions: [".tsx"],
	grammar: TREE_SITTER_GRAMMARS.tsx,
	extractUnits: javascriptAdapter.extractUnits,
	extractImports: javascriptAdapter.extractImports,
};
