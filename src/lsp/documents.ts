import path from "node:path";

import { pathToFileUri } from "./uri.js";
import type { LspClientDocumentContext } from "./types.js";

const extensionLanguageIds = new Map<string, string>([
	[".ts", "typescript"],
	[".tsx", "typescriptreact"],
	[".js", "javascript"],
	[".jsx", "javascriptreact"],
	[".mjs", "javascript"],
	[".cjs", "javascript"],
	[".py", "python"],
	[".pyi", "python"],
	[".rs", "rust"],
]);

/** 跟踪已通过 textDocument/didOpen 打开的文件版本。 */
export class LspDocuments {
	private readonly versions = new Map<string, number>();

	context(filePath: string, text: string, languageId = languageIdForPath(filePath)): LspClientDocumentContext {
		return {
			uri: pathToFileUri(filePath),
			path: filePath,
			text,
			languageId,
		};
	}

	nextVersion(uri: string): number {
		const next = (this.versions.get(uri) ?? 0) + 1;
		this.versions.set(uri, next);
		return next;
	}

	has(uri: string): boolean {
		return this.versions.has(uri);
	}

	count(): number {
		return this.versions.size;
	}

	close(uri: string): boolean {
		return this.versions.delete(uri);
	}

	openUris(): string[] {
		return Array.from(this.versions.keys());
	}

	clear(): void {
		this.versions.clear();
	}
}

export function languageIdForPath(filePath: string): string {
	return extensionLanguageIds.get(path.extname(filePath).toLowerCase()) ?? "plaintext";
}
