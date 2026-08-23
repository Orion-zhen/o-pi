import type { GrammarSpec, TreeSitterLanguageSpec } from "./types.js";

const bash = language("bash", [".sh", ".bash"], grammar("tree-sitter-bash", "tree-sitter-bash.wasm"));
const c = language("c", [".c"], grammar("tree-sitter-c", "tree-sitter-c.wasm"));
const cpp = language("cpp", [".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"], grammar("tree-sitter-cpp", "tree-sitter-cpp.wasm"));
const go = language("go", [".go"], grammar("tree-sitter-go", "tree-sitter-go.wasm"));
const javascript = language("javascript", [".js", ".mjs", ".cjs"], grammar("tree-sitter-javascript", "tree-sitter-javascript.wasm"));
const jsx = language("jsx", [".jsx"], javascript.grammar);
const python = language("python", [".py"], grammar("tree-sitter-python", "tree-sitter-python.wasm"));
const rust = language("rust", [".rs"], grammar("tree-sitter-rust", "tree-sitter-rust.wasm"));
const tsx = language("tsx", [".tsx"], grammar("tree-sitter-typescript", "tree-sitter-tsx.wasm"));
const typescript = language("typescript", [".ts"], grammar("tree-sitter-typescript", "tree-sitter-typescript.wasm"));

/** 语言发现的唯一来源；code-index 会为每个注册项建立完整 adapter。 */
export const TREE_SITTER_LANGUAGES = [
	javascript,
	jsx,
	typescript,
	tsx,
	python,
	go,
	rust,
	c,
	cpp,
	bash,
] as const satisfies readonly TreeSitterLanguageSpec[];

export type TreeSitterLanguage = (typeof TREE_SITTER_LANGUAGES)[number]["language"];
export type RegisteredTreeSitterLanguageSpec = (typeof TREE_SITTER_LANGUAGES)[number];

const languagesByName: { readonly [Language in TreeSitterLanguage]: RegisteredTreeSitterLanguageSpec } = {
	javascript,
	jsx,
	typescript,
	tsx,
	python,
	go,
	rust,
	c,
	cpp,
	bash,
};

export function getTreeSitterLanguage(languageName: TreeSitterLanguage): RegisteredTreeSitterLanguageSpec {
	return languagesByName[languageName];
}

function grammar(packageName: string, wasmFile: string): GrammarSpec {
	return { packageName, wasmFile };
}

function language<const Language extends string>(
	languageName: Language,
	extensions: readonly string[],
	grammarSpec: GrammarSpec,
): TreeSitterLanguageSpec<Language> {
	return { language: languageName, extensions, grammar: grammarSpec };
}
