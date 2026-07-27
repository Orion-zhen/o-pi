import path from "node:path";
import pLimit from "p-limit";

import { throwIfAborted } from "../core/errors.js";
import { compareText, groupBy, uniqueRepoMapEvidence } from "../core/graph.js";
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

/** Builds a deterministic, repository-only lexical index. It never invents synonyms. */
export async function buildRepoMapLexicalAliases(input: BuildRepoMapLexicalAliasesInput): Promise<RepoMapLexicalAlias[]> {
	const aliases: RepoMapLexicalAlias[] = [];
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
	aliases.push(...await sourceAliases(input, termCache, reusableTargets));
	const rebuilt = deduplicateAndLimit(aliases);
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

async function sourceAliases(
	input: BuildRepoMapLexicalAliasesInput,
	termCache: AliasTermCache,
	reusableTargets: ReadonlySet<string>,
): Promise<RepoMapLexicalAlias[]> {
	const readText = input.readText ?? readTextNoFollow;
	const indexed = input.files.filter((file) => file.status === "indexed" && file.contentHash !== undefined);
	const previousFiles = new Map(input.previous?.files.map((file) => [file.path, file]) ?? []);
	const previousAliases = groupBy(
		(input.previous?.aliases ?? []).filter((alias) => SOURCE_ALIAS_TYPES.has(alias.source)),
		(alias) => alias.target,
	);
	const reused: RepoMapLexicalAlias[] = [];
	const changed: RepoMapFileRecord[] = [];
	for (const file of indexed) {
		if (reusableTargets.has(file.id)) continue;
		const previous = previousFiles.get(file.path);
		if (previous?.status === "indexed" && previous.contentHash === file.contentHash) reused.push(...previousAliases.get(file.id) ?? []);
		else changed.push(file);
	}
	const limit = pLimit(input.concurrency);
	const rebuilt = await limit.map(changed, async (file) => {
		throwIfAborted(input.signal);
		try {
			const text = await readText(path.join(input.root, file.path), input.signal, file.size);
			throwIfAborted(input.signal);
			return sha256(text) === file.contentHash ? extractSourceAliases(file, text, termCache) : [];
		} catch {
			throwIfAborted(input.signal);
			return [];
		}
	});
	return [...reused, ...rebuilt.flat()];
}

function extractSourceAliases(file: RepoMapFileRecord, text: string, termCache: AliasTermCache): RepoMapLexicalAlias[] {
	const result: RepoMapLexicalAlias[] = [];
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
	return result;
}

function addTerms(
	result: RepoMapLexicalAlias[],
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
		result.push({ term, canonical, target, source, confidence: SOURCE_CONFIDENCE[source], evidence: [evidence] });
	}
}

function deduplicateAndLimit(input: readonly RepoMapLexicalAlias[]): RepoMapLexicalAlias[] {
	const unique = new Map<string, { alias: RepoMapLexicalAlias; evidence?: RepoMapEvidence[] }>();
	for (const alias of input) {
		const key = [alias.target, alias.term, alias.canonical, alias.source].join("\0");
		const existing = unique.get(key);
		if (existing === undefined) unique.set(key, { alias });
		else {
			existing.evidence ??= [...existing.alias.evidence];
			existing.evidence.push(...alias.evidence);
		}
	}
	const aliases = [...unique.values()].map(({ alias, evidence }) => evidence === undefined
		? alias
		: { ...alias, evidence: uniqueRepoMapEvidence(evidence) });
	const byTarget = groupBy(aliases, (alias) => alias.target);
	return [...byTarget.values()].flatMap((values) => values
		.sort((left, right) => right.confidence - left.confidence || compareText(left.term, right.term) || compareText(left.source, right.source))
		.slice(0, MAX_ALIASES_PER_TARGET))
		.sort(compareAlias);
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
