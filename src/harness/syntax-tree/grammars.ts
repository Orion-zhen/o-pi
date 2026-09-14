import type { GrammarSpec } from "./types.js";

const javascriptGrammar = "tree-sitter-javascript/tree-sitter-javascript.wasm";

/** 语言和扩展名的唯一目录，不依赖代码提取器或 Tree-sitter 运行时。 */
export const TREE_SITTER_LANGUAGES = {
	javascript: { extensions: [".js", ".mjs", ".cjs"], grammar: javascriptGrammar },
	jsx: { extensions: [".jsx"], grammar: javascriptGrammar },
	typescript: { extensions: [".ts"], grammar: "tree-sitter-typescript/tree-sitter-typescript.wasm" },
	tsx: { extensions: [".tsx"], grammar: "tree-sitter-typescript/tree-sitter-tsx.wasm" },
	python: { extensions: [".py"], grammar: "tree-sitter-python/tree-sitter-python.wasm" },
	go: { extensions: [".go"], grammar: "tree-sitter-go/tree-sitter-go.wasm" },
	rust: { extensions: [".rs"], grammar: "tree-sitter-rust/tree-sitter-rust.wasm" },
	c: { extensions: [".c"], grammar: "tree-sitter-c/tree-sitter-c.wasm" },
	cpp: { extensions: [".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"], grammar: "tree-sitter-cpp/tree-sitter-cpp.wasm" },
	bash: { extensions: [".sh", ".bash"], grammar: "tree-sitter-bash/tree-sitter-bash.wasm" },
} as const satisfies Record<string, { extensions: readonly string[]; grammar: GrammarSpec }>;

export type TreeSitterLanguage = keyof typeof TREE_SITTER_LANGUAGES;

const languagesByExtension = new Map<string, TreeSitterLanguage>();
for (const language of Object.keys(TREE_SITTER_LANGUAGES) as TreeSitterLanguage[]) {
	for (const extension of TREE_SITTER_LANGUAGES[language].extensions) languagesByExtension.set(extension, language);
}

export function languageFromPath(filePath: string): TreeSitterLanguage | "text" {
	const normalized = filePath.toLowerCase().replaceAll("\\", "/");
	const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
	const extensionStart = fileName.lastIndexOf(".");
	return extensionStart < 0 ? "text" : languagesByExtension.get(fileName.slice(extensionStart)) ?? "text";
}
