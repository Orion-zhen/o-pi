import type { GrammarSpec } from "./types.js";

export const TREE_SITTER_GRAMMARS = {
	bash: grammar("tree-sitter-bash", "tree-sitter-bash.wasm"),
	c: grammar("tree-sitter-c", "tree-sitter-c.wasm"),
	cpp: grammar("tree-sitter-cpp", "tree-sitter-cpp.wasm"),
	go: grammar("tree-sitter-go", "tree-sitter-go.wasm"),
	javascript: grammar("tree-sitter-javascript", "tree-sitter-javascript.wasm"),
	python: grammar("tree-sitter-python", "tree-sitter-python.wasm"),
	rust: grammar("tree-sitter-rust", "tree-sitter-rust.wasm"),
	tsx: grammar("tree-sitter-typescript", "tree-sitter-tsx.wasm"),
	typescript: grammar("tree-sitter-typescript", "tree-sitter-typescript.wasm"),
} as const satisfies Record<string, GrammarSpec>;

function grammar(packageName: string, wasmFile: string): GrammarSpec {
	return { packageName, wasmFile };
}
