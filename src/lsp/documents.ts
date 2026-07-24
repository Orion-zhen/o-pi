import path from "node:path";
import type { Position, TextDocumentContentChangeEvent } from "vscode-languageserver-protocol";

import type { LspClientDocumentContext, LspDocumentSymbols, LspServerConfig } from "./types.js";
import { pathToFileUri } from "./uri.js";

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

export interface LspDocumentState extends LspClientDocumentContext {
	version: number;
	open: boolean;
	lastUsed: number;
	cachedSymbols?: {
		version: number;
		value: LspDocumentSymbols;
	};
}

/** 有界文档状态、同 URI 操作队列和 documentSymbol version cache。 */
export class LspDocuments {
	private readonly states = new Map<string, LspDocumentState>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly pendingVersions = new Map<string, number>();
	private clock = 0;

	constructor(readonly maxDocuments: number) {}

	context(filePath: string, text: string, languageId: string): LspClientDocumentContext {
		return {
			uri: pathToFileUri(filePath),
			path: filePath,
			text,
			languageId,
		};
	}

	async enqueue<T>(uri: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(uri) ?? Promise.resolve();
		const run = previous.then(operation, operation);
		const tail = run.then(() => undefined, () => undefined);
		this.queues.set(uri, tail);
		try {
			return await run;
		} finally {
			if (this.queues.get(uri) === tail) this.queues.delete(uri);
		}
	}

	state(uri: string): Readonly<LspDocumentState> | undefined {
		return this.states.get(uri);
	}

	currentVersion(uri: string): number | undefined {
		return this.pendingVersions.get(uri) ?? this.states.get(uri)?.version;
	}

	setPendingVersion(uri: string, version: number): void {
		this.pendingVersions.set(uri, version);
	}

	clearPendingVersion(uri: string, version: number): void {
		if (this.pendingVersions.get(uri) === version) this.pendingVersions.delete(uri);
	}

	commit(context: LspClientDocumentContext, version: number, open: boolean): void {
		const previous = this.states.get(context.uri);
		const unchanged = previous?.version === version && previous.text === context.text;
		this.states.set(context.uri, {
			...context,
			version,
			open,
			lastUsed: this.nextClock(),
			...(unchanged && previous.cachedSymbols !== undefined ? { cachedSymbols: previous.cachedSymbols } : {}),
		});
	}

	touch(uri: string): void {
		const state = this.states.get(uri);
		if (state !== undefined) state.lastUsed = this.nextClock();
	}

	cachedSymbols(uri: string, version: number): LspDocumentSymbols | undefined {
		const state = this.states.get(uri);
		if (state?.cachedSymbols?.version !== version) return undefined;
		state.lastUsed = this.nextClock();
		return state.cachedSymbols.value;
	}

	cacheSymbols(uri: string, version: number, value: LspDocumentSymbols): boolean {
		const state = this.states.get(uri);
		if (state === undefined || state.version !== version) return false;
		state.cachedSymbols = { version, value };
		state.lastUsed = this.nextClock();
		return true;
	}

	remove(uri: string): boolean {
		return this.states.delete(uri);
	}

	needsCapacity(uri: string): boolean {
		return !this.states.has(uri) && this.states.size >= this.maxDocuments;
	}

	overCapacity(): boolean {
		return this.states.size > this.maxDocuments;
	}

	evictionCandidate(excludeUri: string): string | undefined {
		let candidate: LspDocumentState | undefined;
		for (const state of this.states.values()) {
			if (state.uri === excludeUri || this.queues.has(state.uri)) continue;
			if (candidate === undefined || state.lastUsed < candidate.lastUsed) candidate = state;
		}
		return candidate?.uri;
	}

	openCount(): number {
		let count = 0;
		for (const state of this.states.values()) {
			if (state.open) count += 1;
		}
		return count;
	}

	openUris(): string[] {
		return Array.from(this.states.values()).flatMap((state) => state.open ? [state.uri] : []);
	}

	clear(): void {
		this.states.clear();
		this.queues.clear();
		this.pendingVersions.clear();
	}

	private nextClock(): number {
		this.clock += 1;
		return this.clock;
	}
}

export function languageIdForServerPath(server: LspServerConfig, filePath: string): string {
	const extension = path.extname(filePath).toLowerCase();
	return server.language_ids[extension] ?? server.language_id ?? languageIdForPath(filePath);
}

export function languageIdForPath(filePath: string): string {
	return extensionLanguageIds.get(path.extname(filePath).toLowerCase()) ?? "plaintext";
}

/** 生成一个基于旧文本 UTF-16 code unit 的最小 replacement change。 */
export function incrementalContentChange(previous: string, next: string): TextDocumentContentChangeEvent {
	let prefix = 0;
	const sharedLength = Math.min(previous.length, next.length);
	while (prefix < sharedLength && previous.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1;
	if (splitsCrLf(previous, prefix) || splitsCrLf(next, prefix)) prefix -= 1;

	let suffix = 0;
	while (
		suffix < previous.length - prefix
		&& suffix < next.length - prefix
		&& previous.charCodeAt(previous.length - suffix - 1) === next.charCodeAt(next.length - suffix - 1)
	) {
		suffix += 1;
	}
	while (suffix > 0 && (splitsCrLf(previous, previous.length - suffix) || splitsCrLf(next, next.length - suffix))) {
		suffix -= 1;
	}

	const previousEnd = previous.length - suffix;
	const nextEnd = next.length - suffix;
	return {
		range: {
			start: positionAt(previous, prefix),
			end: positionAt(previous, previousEnd),
		},
		text: next.slice(prefix, nextEnd),
	};
}

function positionAt(text: string, offset: number): Position {
	let line = 0;
	let lineStart = 0;
	let index = 0;
	while (index < offset) {
		const code = text.charCodeAt(index);
		if (code === 13) {
			index += text.charCodeAt(index + 1) === 10 ? 2 : 1;
			line += 1;
			lineStart = index;
			continue;
		}
		if (code === 10) {
			index += 1;
			line += 1;
			lineStart = index;
			continue;
		}
		index += 1;
	}
	return { line, character: offset - lineStart };
}

function splitsCrLf(text: string, offset: number): boolean {
	return offset > 0 && offset < text.length && text.charCodeAt(offset - 1) === 13 && text.charCodeAt(offset) === 10;
}
