import { javascriptAdapter } from "./javascript.js";
import { getTreeSitterLanguage } from "../../syntax-tree/grammars.js";
import type { LanguageAdapter } from "./types.js";

export const typescriptAdapter: LanguageAdapter = {
	...getTreeSitterLanguage("typescript"),
	extractUnits: javascriptAdapter.extractUnits,
	extractImports: javascriptAdapter.extractImports,
};

export const tsxAdapter: LanguageAdapter = {
	...getTreeSitterLanguage("tsx"),
	extractUnits: javascriptAdapter.extractUnits,
	extractImports: javascriptAdapter.extractImports,
};
