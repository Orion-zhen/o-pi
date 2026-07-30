import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const TREE_SITTER_PACKAGES = [
	"web-tree-sitter",
	"tree-sitter-bash",
	"tree-sitter-c",
	"tree-sitter-cpp",
	"tree-sitter-go",
	"tree-sitter-javascript",
	"tree-sitter-python",
	"tree-sitter-rust",
	"tree-sitter-typescript",
] as const;

export function dependencyPath(packageName: string): string {
	return require.resolve(packageName);
}

export function treeSitterModulePaths(packages: readonly string[] = TREE_SITTER_PACKAGES): string[] {
	return packages.map(dependencyPath);
}
