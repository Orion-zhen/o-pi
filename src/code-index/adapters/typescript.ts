import { javascriptAdapter } from "./javascript.js";
import type { LanguageAdapter } from "./types.js";

export const typescriptAdapter: LanguageAdapter = {
	language: "typescript",
	extensions: [".ts"],
	grammar: { packageName: "tree-sitter-typescript", wasmFile: "tree-sitter-typescript.wasm" },
	extractUnits: javascriptAdapter.extractUnits,
	extractImports: javascriptAdapter.extractImports,
};

export const tsxAdapter: LanguageAdapter = {
	language: "tsx",
	extensions: [".tsx"],
	grammar: { packageName: "tree-sitter-typescript", wasmFile: "tree-sitter-tsx.wasm" },
	extractUnits: javascriptAdapter.extractUnits,
	extractImports: javascriptAdapter.extractImports,
};
