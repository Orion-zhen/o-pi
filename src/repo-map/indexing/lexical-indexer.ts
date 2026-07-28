import path from "node:path";

import { throwIfAborted } from "../core/errors.js";
import { compareRepoMapEvidence, compareText, groupBy } from "../core/graph.js";
import { fileEvidence, readTextNoFollow, sha256, symbolEvidence, type RepoMapReadText } from "../core/source.js";
import type {
	RepoMapAliasSource,
	RepoMapArchitectureNode,
	RepoMapEdge,
	RepoMapEvidence,
	RepoMapFileRecord,
	RepoMapLexicalAlias,
	RepoMapSymbolNode,
} from "../core/types.js";

export interface BuildRepoMapLexicalAliasesInput {
	root: string;
	files: readonly RepoMapFileRecord[];
	symbols: readonly RepoMapSymbolNode[];
	architecture: readonly RepoMapArchitectureNode[];
	edges: readonly RepoMapEdge[];
	concurrency: number;
	previous?: {
		files: readonly RepoMapFileRecord[];
		symbols: readonly RepoMapSymbolNode[];
		architecture: readonly RepoMapArchitectureNode[];
		edges: readonly RepoMapEdge[];
		aliases: readonly RepoMapLexicalAlias[];
	};
	signal?: AbortSignal;
	readText?: RepoMapReadText;
}

const FIXED_EXPANSIONS = new Map<string, string>([
	["repo", "repository"], ["cmd", "command"], ["cfg", "config"], ["ctx", "context"],
	["deps", "dependencies"], ["diag", "diagnostics"],
]);
const LOW_INFORMATION = new Set([
	"and", "any", "are", "const", "data", "default", "else", "export", "false", "file", "for", "from", "function",
	"get", "has", "import", "index", "interface", "into", "let", "main", "new", "none", "null", "object", "return", "set",
	"src", "test", "that", "the", "this", "true", "type", "undefined", "use", "value", "with",
]);
const SOURCE_CONFIDENCE: Record<RepoMapAliasSource, number> = {
	"file-path": 0.78,
	symbol: 0.96,
	signature: 0.76,
	"import-alias": 0.94,
	"export-alias": 0.94,
	architecture: 0.92,
	registration: 0.98,
	"config-key": 0.86,
	environment: 0.9,
	"doc-comment": 0.68,
};
const MAX_ALIASES_PER_TARGET = 96;
const SOURCE_ALIAS_TYPES = new Set<RepoMapAliasSource>(["import-alias", "export-alias", "config-key", "environment", "doc-comment"]);

interface AliasTermCache {
	terms: Map<string, readonly string[]>;
	canonical: Map<string, string>;
}

interface AccumulatedAlias {
	alias: RepoMapLexicalAlias;
	sequence: number;
	evidence?: Map<string, RepoMapEvidence>;
}

interface AliasBucket {
	entries: Map<string, AccumulatedAlias>;
	worstFirst: AccumulatedAlias[];
}

class AliasAccumulator {
	readonly #buckets = new Map<string, AliasBucket>();
	#sequence = 0;

	addTerm(
		term: string,
		canonical: string,
		target: string,
		source: RepoMapAliasSource,
		confidence: number,
		evidence: RepoMapEvidence,
	): void {
		const bucket = this.#bucket(target);
		const key = aliasBucketKey(term, canonical, source);
		const existing = bucket.entries.get(key);
		if (existing !== undefined) {
			mergeAliasEvidenceValue(existing, evidence);
			return;
		}
		if (!candidateCanEnter(bucket, confidence, term, source)) return;
		this.#insert(bucket, key, {
			alias: { term, canonical, target, source, confidence, evidence: [evidence] },
			sequence: this.#sequence,
		});
		this.#sequence += 1;
	}

	addAlias(alias: RepoMapLexicalAlias): void {
		const bucket = this.#bucket(alias.target);
		const key = aliasBucketKey(alias.term, alias.canonical, alias.source);
		const existing = bucket.entries.get(key);
		if (existing !== undefined) {
			mergeAliasEvidence(existing, alias.evidence);
			return;
		}
		if (!candidateCanEnter(bucket, alias.confidence, alias.term, alias.source)) return;
		this.#insert(bucket, key, { alias, sequence: this.#sequence });
		this.#sequence += 1;
	}

	finalize(): RepoMapLexicalAlias[] {
		const result: RepoMapLexicalAlias[] = [];
		for (const bucket of this.#buckets.values()) {
			for (const entry of bucket.entries.values()) {
				result.push(entry.evidence === undefined
					? entry.alias
					: { ...entry.alias, evidence: Array.from(entry.evidence.values()).sort(compareRepoMapEvidence) });
			}
		}
		return result.sort(compareAlias);
	}

	#bucket(target: string): AliasBucket {
		let bucket = this.#buckets.get(target);
		if (bucket === undefined) {
			bucket = { entries: new Map(), worstFirst: [] };
			this.#buckets.set(target, bucket);
		}
		return bucket;
	}

	#insert(bucket: AliasBucket, key: string, entry: AccumulatedAlias): void {
		if (bucket.worstFirst.length < MAX_ALIASES_PER_TARGET) {
			bucket.entries.set(key, entry);
			heapPushWorst(bucket.worstFirst, entry);
			return;
		}
		const evicted = bucket.worstFirst[0];
		if (evicted === undefined) throw new Error("alias accumulator heap is empty");
		bucket.entries.delete(aliasBucketKey(evicted.alias.term, evicted.alias.canonical, evicted.alias.source));
		bucket.entries.set(key, entry);
		bucket.worstFirst[0] = entry;
		heapSiftWorstDown(bucket.worstFirst, 0);
	}
}

function aliasBucketKey(term: string, canonical: string, source: RepoMapAliasSource): string {
	return [term, canonical, source].join("\0");
}

function mergeAliasEvidence(entry: AccumulatedAlias, evidence: readonly RepoMapEvidence[]): void {
	for (const value of evidence) mergeAliasEvidenceValue(entry, value);
}

function mergeAliasEvidenceValue(entry: AccumulatedAlias, evidence: RepoMapEvidence): void {
	if (entry.evidence === undefined) {
		entry.evidence = new Map();
		for (const value of entry.alias.evidence) entry.evidence.set(repoMapEvidenceKey(value), value);
	}
	entry.evidence.set(repoMapEvidenceKey(evidence), evidence);
}

function repoMapEvidenceKey(evidence: RepoMapEvidence): string {
	return [evidence.path, evidence.startByte, evidence.endByte, evidence.textHash ?? ""].join("\0");
}

function candidateCanEnter(bucket: AliasBucket, confidence: number, term: string, source: RepoMapAliasSource): boolean {
	if (bucket.worstFirst.length < MAX_ALIASES_PER_TARGET) return true;
	const worst = bucket.worstFirst[0];
	if (worst === undefined) throw new Error("alias accumulator heap is empty");
	return compareAliasRankValues(confidence, term, source, worst.alias) < 0;
}

function compareAliasRankValues(
	confidence: number,
	term: string,
	source: RepoMapAliasSource,
	right: RepoMapLexicalAlias,
): number {
	return right.confidence - confidence || compareText(term, right.term) || compareText(source, right.source);
}

function compareAccumulatedAliasRank(left: AccumulatedAlias, right: AccumulatedAlias): number {
	return compareAliasRankValues(left.alias.confidence, left.alias.term, left.alias.source, right.alias)
		|| left.sequence - right.sequence;
}

function heapPushWorst(heap: AccumulatedAlias[], entry: AccumulatedAlias): void {
	heap.push(entry);
	let index = heap.length - 1;
	while (index > 0) {
		const parentIndex = Math.floor((index - 1) / 2);
		const value = heap[index];
		const parent = heap[parentIndex];
		if (value === undefined || parent === undefined || compareAccumulatedAliasRank(value, parent) <= 0) return;
		heap[index] = parent;
		heap[parentIndex] = value;
		index = parentIndex;
	}
}

function heapSiftWorstDown(heap: AccumulatedAlias[], startIndex: number): void {
	let index = startIndex;
	while (true) {
		let worstIndex = index;
		const leftIndex = index * 2 + 1;
		const rightIndex = leftIndex + 1;
		const currentWorst = heap[worstIndex];
		const left = heap[leftIndex];
		if (currentWorst !== undefined && left !== undefined && compareAccumulatedAliasRank(left, currentWorst) > 0) worstIndex = leftIndex;
		const worst = heap[worstIndex];
		const right = heap[rightIndex];
		if (worst !== undefined && right !== undefined && compareAccumulatedAliasRank(right, worst) > 0) worstIndex = rightIndex;
		if (worstIndex === index) return;
		const value = heap[index];
		const replacement = heap[worstIndex];
		if (value === undefined || replacement === undefined) throw new Error("alias accumulator heap is sparse");
		heap[index] = replacement;
		heap[worstIndex] = value;
		index = worstIndex;
	}
}

/** Builds a deterministic, repository-only lexical index. It never invents synonyms. */
export async function buildRepoMapLexicalAliases(input: BuildRepoMapLexicalAliasesInput): Promise<RepoMapLexicalAlias[]> {
	const aliases = new AliasAccumulator();
	const termCache: AliasTermCache = { terms: new Map(), canonical: new Map() };
	const filesById = new Map(input.files.map((file) => [file.id, file]));
	const filesByPath = new Map(input.files.map((file) => [file.path, file]));
	const packagesById = new Map(input.architecture
		.filter((node) => node.kind === "package")
		.map((node) => [node.id, node]));
	const reusableTargets = reusableAliasTargets(input, filesById, filesByPath, packagesById);
	for (const file of input.files) {
		if (reusableTargets.has(file.id)) continue;
		const evidence = fileEvidence(file);
		for (const segment of file.path.split("/")) addTerms(aliases, pathStem(segment), file.id, "file-path", evidence, termCache);
	}
	for (const symbol of input.symbols) {
		if (reusableTargets.has(symbol.id)) continue;
		const file = filesById.get(symbol.fileId);
		if (file === undefined) continue;
		const evidence = symbolEvidence(file, symbol);
		for (const value of [symbol.name, symbol.qualifiedName]) if (value !== undefined) addTerms(aliases, value, symbol.id, "symbol", evidence, termCache);
		if (symbol.signature !== undefined) addTerms(aliases, symbol.signature, symbol.id, "signature", evidence, termCache, true);
	}
	for (const node of input.architecture) {
		if (reusableTargets.has(node.id)) continue;
		const evidence = architectureEvidence(node, filesById, filesByPath, packagesById);
		const source: RepoMapAliasSource = node.kind === "entrypoint"
			&& (node.entrypointType === "command" || node.entrypointType === "tool" || node.entrypointType === "plugin")
			? "registration"
			: "architecture";
		for (const value of node.kind === "entrypoint" ? [node.name, node.entrypointType, node.declaredTarget] : [node.name, node.rootPath]) {
			if (value !== undefined) addTerms(aliases, value, node.id, source, evidence, termCache);
		}
	}
	for (const edge of input.edges) {
		if (reusableTargets.has(edge.from) || edge.lexicalTarget === undefined || edge.evidence.length === 0) continue;
		const source = edge.kind === "imports" ? "import-alias" : "symbol";
		for (const evidence of edge.evidence) addTerms(aliases, edge.lexicalTarget, edge.from, source, evidence, termCache);
	}
	await appendSourceAliases(input, termCache, reusableTargets, aliases);
	const rebuilt = aliases.finalize();
	const reused = (input.previous?.aliases ?? []).filter((alias) => reusableTargets.has(alias.target));
	return mergeSortedAliases(rebuilt, reused);
}

export function lexicalTerms(value: string): string[] {
	const separated = value
		.replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
		.replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, "$1 $2")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.toLocaleLowerCase();
	if (separated.length === 0) return [];
	const tokens = separated.split(/\s+/u).filter(informative);
	const phrase = tokens.join(" ");
	return [...new Set([...(tokens.length > 1 ? [phrase] : []), ...tokens])];
}

export function canonicalLexicalTerm(term: string): string {
	if (!term.includes(" ")) return FIXED_EXPANSIONS.get(term) ?? term;
	return term.split(" ").map((token) => FIXED_EXPANSIONS.get(token) ?? token).join(" ");
}

function sourceAliasWorkerCount(concurrency: number, fileCount: number): number {
	if (concurrency !== Number.POSITIVE_INFINITY && (!Number.isInteger(concurrency) || concurrency < 1)) {
		throw new TypeError("concurrency must be a positive integer or Infinity");
	}
	return Math.min(concurrency, fileCount);
}

async function appendSourceAliases(
	input: BuildRepoMapLexicalAliasesInput,
	termCache: AliasTermCache,
	reusableTargets: ReadonlySet<string>,
	result: AliasAccumulator,
): Promise<void> {
	const readText = input.readText ?? readTextNoFollow;
	const previousFiles = new Map(input.previous?.files.map((file) => [file.path, file]) ?? []);
	const previousAliases = groupBy(
		(input.previous?.aliases ?? []).filter((alias) => SOURCE_ALIAS_TYPES.has(alias.source) && !reusableTargets.has(alias.target)),
		(alias) => alias.target,
	);
	const workerCount = sourceAliasWorkerCount(input.concurrency, input.files.length);
	let nextFileIndex = 0;
	const work = async (): Promise<void> => {
		while (true) {
			throwIfAborted(input.signal);
			const file = input.files[nextFileIndex];
			nextFileIndex += 1;
			if (file === undefined) return;
			if (file.status !== "indexed" || file.contentHash === undefined || reusableTargets.has(file.id)) continue;
			const previous = previousFiles.get(file.path);
			if (previous?.status === "indexed" && previous.contentHash === file.contentHash) {
				for (const alias of previousAliases.get(file.id) ?? []) result.addAlias(alias);
				continue;
			}
			try {
				const text = await readText(path.join(input.root, file.path), input.signal, file.size);
				throwIfAborted(input.signal);
				if (sha256(text) === file.contentHash) extractSourceAliases(file, text, termCache, result);
			} catch {
				throwIfAborted(input.signal);
			}
		}
	};
	await Promise.all(Array.from({ length: workerCount }, work));
}

function extractSourceAliases(file: RepoMapFileRecord, text: string, termCache: AliasTermCache, result: AliasAccumulator): void {
	const addMatch = (expression: RegExp, source: RepoMapAliasSource, groups: readonly number[]): void => {
		for (const match of text.matchAll(expression)) {
			const startByte = Buffer.byteLength(text.slice(0, match.index), "utf8");
			const endByte = startByte + Buffer.byteLength(match[0], "utf8");
			const line = 1 + countNewlines(text, match.index);
			const evidence: RepoMapEvidence = { path: file.path, ...(file.contentHash !== undefined ? { textHash: file.contentHash } : {}), startLine: line, endLine: line + countNewlines(match[0], match[0].length), startByte, endByte };
			for (const group of groups) {
				const value = match[group];
				if (value !== undefined) addTerms(result, value, file.id, source, evidence, termCache);
			}
		}
	};
	const addAliasBlocks = (expression: RegExp, source: "import-alias" | "export-alias"): void => {
		for (const block of text.matchAll(expression)) {
			const body = block[1];
			if (body === undefined) continue;
			const startByte = Buffer.byteLength(text.slice(0, block.index), "utf8");
			const endByte = startByte + Buffer.byteLength(block[0], "utf8");
			const line = 1 + countNewlines(text, block.index);
			const evidence: RepoMapEvidence = { path: file.path, ...(file.contentHash !== undefined ? { textHash: file.contentHash } : {}), startLine: line, endLine: line, startByte, endByte };
			for (const pair of body.matchAll(/\b([\p{L}_$][\w$]*)\s+as\s+([\p{L}_$][\w$]*)/gu)) {
				for (const value of [pair[1], pair[2]]) if (value !== undefined) addTerms(result, value, file.id, source, evidence, termCache);
			}
		}
	};
	addAliasBlocks(/\bimport\s*\{([^}\n]*)\}/gu, "import-alias");
	addMatch(/\bimport\s+(?:\*\s+as\s+)?([\p{L}_$][\w$]*)\s+from\s+["'][^"']+["']/gu, "import-alias", [1]);
	addMatch(/\b(?:from\s+[\w.]+\s+)?import\s+[\w.]+\s+as\s+([\p{L}_][\w]*)/gu, "import-alias", [1]);
	addAliasBlocks(/\bexport\s*\{([^}\n]*)\}/gu, "export-alias");
	addMatch(/(?:["']([a-z][a-zA-Z0-9_.-]{2,})["']|^\s*([a-z][a-zA-Z0-9_.-]{2,})\s*)\s*[:=]/gmu, "config-key", [1, 2]);
	addMatch(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/gu, "environment", [1]);
	for (const comment of text.matchAll(/\/\*\*[\s\S]*?\*\/|^\s*(?:\/\/\/|##?)[^\n]*/gmu)) {
		const startByte = Buffer.byteLength(text.slice(0, comment.index), "utf8");
		const endByte = startByte + Buffer.byteLength(comment[0], "utf8");
		const startLine = 1 + countNewlines(text, comment.index);
		const evidence: RepoMapEvidence = { path: file.path, ...(file.contentHash !== undefined ? { textHash: file.contentHash } : {}), startLine, endLine: startLine + countNewlines(comment[0], comment[0].length), startByte, endByte };
		for (const token of comment[0].match(/[\p{L}][\p{L}\p{N}_-]{3,}/gu) ?? []) addTerms(result, token, file.id, "doc-comment", evidence, termCache);
	}
}

function addTerms(
	result: AliasAccumulator,
	value: string,
	target: string,
	source: RepoMapAliasSource,
	evidence: RepoMapEvidence,
	termCache: AliasTermCache,
	tokensOnly = false,
): void {
	let terms = termCache.terms.get(value);
	if (terms === undefined) {
		terms = lexicalTerms(value);
		termCache.terms.set(value, terms);
	}
	for (const term of terms) {
		if (tokensOnly && term.includes(" ")) continue;
		let canonical = termCache.canonical.get(term);
		if (canonical === undefined) {
			canonical = canonicalLexicalTerm(term);
			termCache.canonical.set(term, canonical);
		}
		result.addTerm(term, canonical, target, source, SOURCE_CONFIDENCE[source], evidence);
	}
}

function informative(token: string): boolean {
	return token.length >= 3 && !LOW_INFORMATION.has(token) && !/^\d+$/u.test(token);
}

function reusableAliasTargets(
	input: BuildRepoMapLexicalAliasesInput,
	filesById: ReadonlyMap<string, RepoMapFileRecord>,
	filesByPath: ReadonlyMap<string, RepoMapFileRecord>,
	packagesById: ReadonlyMap<string, Extract<RepoMapArchitectureNode, { kind: "package" }>>,
): Set<string> {
	const previous = input.previous;
	if (previous === undefined) return new Set();
	const previousFilesById = new Map(previous.files.map((file) => [file.id, file]));
	const previousFilesByPath = new Map(previous.files.map((file) => [file.path, file]));
	const previousPackagesById = new Map(previous.architecture
		.filter((node) => node.kind === "package")
		.map((node) => [node.id, node]));
	const currentFingerprints = aliasInputFingerprints(
		input.files,
		input.symbols,
		input.architecture,
		input.edges,
		filesById,
		filesByPath,
		packagesById,
	);
	const previousFingerprints = aliasInputFingerprints(
		previous.files,
		previous.symbols,
		previous.architecture,
		previous.edges,
		previousFilesById,
		previousFilesByPath,
		previousPackagesById,
	);
	return new Set([...currentFingerprints].flatMap(([target, fingerprint]) =>
		previousFingerprints.get(target) === fingerprint ? [target] : []));
}

function aliasInputFingerprints(
	files: readonly RepoMapFileRecord[],
	symbols: readonly RepoMapSymbolNode[],
	architecture: readonly RepoMapArchitectureNode[],
	edges: readonly RepoMapEdge[],
	filesById: ReadonlyMap<string, RepoMapFileRecord>,
	filesByPath: ReadonlyMap<string, RepoMapFileRecord>,
	packagesById: ReadonlyMap<string, Extract<RepoMapArchitectureNode, { kind: "package" }>>,
): Map<string, string> {
	const contributions = new Map<string, string[]>();
	const append = (target: string, value: unknown): void => {
		const encoded = JSON.stringify(value);
		const values = contributions.get(target);
		if (values === undefined) contributions.set(target, [encoded]);
		else values.push(encoded);
	};
	for (const file of files) append(file.id, ["file", file.path, file.status, file.contentHash ?? null]);
	for (const symbol of symbols) {
		const file = filesById.get(symbol.fileId);
		if (file === undefined) continue;
		append(symbol.id, [
			"symbol", symbol.name ?? null, symbol.qualifiedName ?? null, symbol.signature ?? null,
			file.path, file.contentHash ?? null, symbol.startLine, symbol.endLine, symbol.startByte, symbol.endByte,
		]);
	}
	for (const node of architecture) {
		const source: RepoMapAliasSource = node.kind === "entrypoint"
			&& (node.entrypointType === "command" || node.entrypointType === "tool" || node.entrypointType === "plugin")
			? "registration"
			: "architecture";
		const values = node.kind === "entrypoint" ? [node.name, node.entrypointType, node.declaredTarget] : [node.name, node.rootPath];
		append(node.id, ["architecture", source, values, architectureEvidence(node, filesById, filesByPath, packagesById)]);
	}
	for (const edge of edges) {
		if (edge.lexicalTarget === undefined || edge.evidence.length === 0) continue;
		append(edge.from, ["edge", edge.kind === "imports" ? "import-alias" : "symbol", edge.lexicalTarget, edge.evidence]);
	}
	return new Map([...contributions].map(([target, values]) => [target, values.sort(compareText).join("\0")]));
}

function mergeSortedAliases(rebuilt: readonly RepoMapLexicalAlias[], reused: readonly RepoMapLexicalAlias[]): RepoMapLexicalAlias[] {
	const result: RepoMapLexicalAlias[] = [];
	let rebuiltIndex = 0;
	let reusedIndex = 0;
	while (rebuiltIndex < rebuilt.length || reusedIndex < reused.length) {
		const rebuiltAlias = rebuilt[rebuiltIndex];
		const reusedAlias = reused[reusedIndex];
		if (reusedAlias === undefined || rebuiltAlias !== undefined && compareAlias(rebuiltAlias, reusedAlias) <= 0) {
			if (rebuiltAlias !== undefined) result.push(rebuiltAlias);
			rebuiltIndex += 1;
		} else {
			result.push(reusedAlias);
			reusedIndex += 1;
		}
	}
	return result;
}

function pathStem(segment: string): string {
	const extension = path.posix.extname(segment);
	return extension.length === 0 ? segment : segment.slice(0, -extension.length);
}

function architectureEvidence(
	node: RepoMapArchitectureNode,
	filesById: ReadonlyMap<string, RepoMapFileRecord>,
	filesByPath: ReadonlyMap<string, RepoMapFileRecord>,
	packagesById: ReadonlyMap<string, Extract<RepoMapArchitectureNode, { kind: "package" }>>,
): RepoMapEvidence {
	const owner = node.kind === "entrypoint" && node.packageId !== undefined
		? packagesById.get(node.packageId)
		: undefined;
	const pathValue = node.kind === "package"
		? node.manifestPath
		: node.kind === "entrypoint" && node.source === "manifest" && owner?.kind === "package"
			? owner.manifestPath
			: node.kind === "entrypoint" && node.fileId !== undefined
				? filesById.get(node.fileId)?.path
				: undefined;
	const file = pathValue === undefined ? undefined : filesByPath.get(pathValue);
	return file === undefined
		? { path: pathValue ?? ".", startLine: 1, endLine: 1, startByte: 0, endByte: 0 }
		: fileEvidence(file);
}

function compareAlias(left: RepoMapLexicalAlias, right: RepoMapLexicalAlias): number {
	return compareText(left.term, right.term) || compareText(left.canonical, right.canonical) || compareText(left.target, right.target) || compareText(left.source, right.source);
}

function countNewlines(value: string, end: number): number {
	let count = 0;
	for (let index = 0; index < end; index += 1) if (value.charCodeAt(index) === 10) count += 1;
	return count;
}
