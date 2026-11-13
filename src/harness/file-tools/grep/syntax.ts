import type { AnalyzedFileIndex, CodeDocument } from "../../code-index/types.ts";
import { languageFromPath } from "../../syntax-tree/grammars.ts";
import { AbortGrepParse, GrepParser } from "./parser-pool.ts";

const AST_CACHE_MAX_ENTRIES = 2_048;

export interface ParsedGrepDocument<T extends CodeDocument = CodeDocument> {
	readonly document: T;
	readonly analysis: AnalyzedFileIndex;
}

/** 跨调用只缓存正文派生的语法，不保存查询关系。 */
export class GrepSyntax {
	private readonly parser = new GrepParser();
	private readonly cache = new Map<string, AnalyzedFileIndex>();

	async analyze<T extends CodeDocument>(documents: readonly T[], filesystemId: string, signal: AbortSignal): Promise<ParsedGrepDocument<T>[]> {
		const results: ParsedGrepDocument<T>[] = [];
		const pending: Array<T & { readonly cacheKey: string }> = [];
		for (const document of documents) {
			const cacheKey = [filesystemId, document.path, document.hash].join("\0");
			const cached = this.cache.get(cacheKey);
			if (cached === undefined) pending.push({ ...document, cacheKey });
			else {
				this.cache.delete(cacheKey);
				this.cache.set(cacheKey, cached);
				results.push({ document, analysis: cached });
			}
		}
		try {
			for (const { file, analysis } of await this.parser.analyzeFiles(pending, signal)) {
				this.cache.set(file.cacheKey, analysis);
				results.push({ document: file, analysis });
			}
		} catch (error) {
			if (signal.aborted || error instanceof AbortGrepParse) throw error;
			// worker 失败只取消结构增强，不在主线程重试。
			for (const document of pending) results.push({ document, analysis: {
				path: document.path, language: languageFromPath(document.path), status: "error", units: [],
			} });
		}
		while (this.cache.size > AST_CACHE_MAX_ENTRIES) {
			const oldest = this.cache.keys().next();
			if (oldest.done) break;
			this.cache.delete(oldest.value);
		}
		return results;
	}

	dispose(): void {
		this.cache.clear();
		this.parser.dispose();
	}
}
