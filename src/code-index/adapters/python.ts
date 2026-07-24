import type { LanguageAdapterMetadata } from "./types.js";

export const pythonAdapter: LanguageAdapterMetadata = {
	language: "python",
	extensions: [".py"],
	grammar: { packageName: "tree-sitter-python" },
};
