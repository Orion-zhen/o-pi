import type { AnalyzedFileIndex, CodeDocument } from "../../code-index/types.ts";
import type { TextContent } from "../../filesystem/contracts/content.ts";
import type { FsResult } from "../../filesystem/contracts/result.ts";
import type { WorkspaceFileSystem } from "../../filesystem/contracts/workspace.ts";
import { languageFromPath } from "../../syntax-tree/grammars.ts";
import type { GrepContentCacheLease } from "./content-cache.ts";
import type { ScopeInventory, ScopedFile } from "./inventory.ts";
import { GrepSyntax, type ParsedGrepDocument } from "./syntax.ts";

export interface GrepDocument extends CodeDocument {
	readonly file: ScopedFile;
}

interface SyntaxTask {
	readonly signal: AbortSignal;
	readonly pending: Promise<AnalyzedFileIndex>;
}

/** 本次搜索统一加载稳定正文，并共享未取消的语法任务。 */
export class GrepDocuments {
	private readonly files: ReadonlyMap<string, ScopedFile>;
	private readonly contents = new Map<string, Promise<FsResult<TextContent>>>();
	private readonly loads = new Map<string, Promise<FsResult<GrepDocument | undefined>>>();
	private readonly analyses = new Map<string, SyntaxTask>();

	constructor(
		inventory: ScopeInventory,
		private readonly filesystem: WorkspaceFileSystem,
		private readonly contentCache: GrepContentCacheLease,
		readonly maxFileBytes: number,
		private readonly parser: GrepSyntax,
		private readonly signal: AbortSignal,
	) {
		this.files = new Map(inventory.files
			.filter((file) => file.snapshot.sizeBytes <= maxFileBytes && languageFromPath(file.path) !== "text")
			.map((file) => [file.path, file]));
	}

	eligible(path: string): boolean {
		return this.files.has(path);
	}

	text(file: ScopedFile): Promise<FsResult<TextContent>> {
		let pending = this.contents.get(file.path);
		if (pending === undefined) {
			pending = this.readText(file);
			this.contents.set(file.path, pending);
		}
		return pending;
	}

	retain(paths: ReadonlySet<string>): void {
		for (const path of this.contents.keys()) if (!paths.has(path)) this.contents.delete(path);
	}

	load(path: string): Promise<FsResult<GrepDocument | undefined>> {
		let pending = this.loads.get(path);
		if (pending === undefined) {
			pending = this.read(path);
			this.loads.set(path, pending);
		}
		return pending;
	}

	async syntax(document: CodeDocument, signal = this.signal): Promise<AnalyzedFileIndex> {
		const existing = this.analyses.get(document.path);
		if (existing !== undefined && !existing.signal.aborted) return existing.pending;
		const pending = this.parser.analyze([document], this.filesystem.identity, signal).then(([parsed]) => {
			if (parsed === undefined) throw new Error("Missing syntax analysis");
			return parsed.analysis;
		});
		const task = { signal, pending };
		this.analyses.set(document.path, task);
		try {
			return await pending;
		} catch (error) {
			if (this.analyses.get(document.path) === task) this.analyses.delete(document.path);
			throw error;
		}
	}

	async analyze(documents: readonly GrepDocument[]): Promise<ParsedGrepDocument<GrepDocument>[]> {
		const pending: GrepDocument[] = [];
		const existing: Array<Promise<ParsedGrepDocument<GrepDocument>>> = [];
		for (const document of documents) {
			const task = this.analyses.get(document.path);
			if (task !== undefined && !task.signal.aborted) existing.push(task.pending.then((analysis) => ({ document, analysis })));
			else pending.push(document);
		}
		const fresh = await this.parser.analyze(pending, this.filesystem.identity, this.signal);
		for (const { document, analysis } of fresh) this.analyses.set(document.path, { signal: this.signal, pending: Promise.resolve(analysis) });
		return [...fresh, ...await Promise.all(existing)];
	}

	private async read(path: string): Promise<FsResult<GrepDocument | undefined>> {
		const file = this.files.get(path);
		if (file === undefined) return { ok: true, value: undefined };
		const loaded = await this.text(file);
		if (!loaded.ok) return loaded;
		const content = loaded.value;
		if (/\r(?!\n)/u.test(content.text)) return { ok: true, value: undefined };
		return { ok: true, value: { path, text: content.text, hash: content.hash, file } };
	}

	private async readText(file: ScopedFile): Promise<FsResult<TextContent>> {
		const cached = await this.contentCache.get(file, this.filesystem, { signal: this.signal });
		if (cached !== undefined) return { ok: true, value: cached };
		const loaded = await this.filesystem.content.readText(file.ref, { maxBytes: this.maxFileBytes, expectedSnapshot: file.snapshot });
		if (loaded.ok) this.contentCache.set(file, this.filesystem, loaded.value);
		return loaded;
	}
}
