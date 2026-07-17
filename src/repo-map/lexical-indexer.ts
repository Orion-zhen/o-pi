import path from "node:path";
import pLimit from "p-limit";

import { throwIfAborted } from "./errors.js";
import { compareText, groupBy, uniqueRepoMapEvidence } from "./graph.js";
import { fileEvidence, readTextNoFollow, sha256, symbolEvidence, type RepoMapReadText } from "./source.js";
import type {
	RepoMapAliasSource,
	RepoMapArchitectureNode,
	RepoMapEdge,
	RepoMapEvidence,
	RepoMapFileRecord,
	RepoMapLexicalAlias,
	RepoMapSymbolNode,
} from "./types.js";

export interface BuildRepoMapLexicalAliasesInput {
	root: string;
	files: readonly RepoMapFileRecord[];
	symbols: readonly RepoMapSymbolNode[];
	architecture: readonly RepoMapArchitectureNode[];
	edges: readonly RepoMapEdge[];
	concurrency: number;
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

/** Builds a deterministic, repository-only lexical index. It never invents synonyms. */
export async function buildRepoMapLexicalAliases(input: BuildRepoMapLexicalAliasesInput): Promise<RepoMapLexicalAlias[]> {
	const aliases: RepoMapLexicalAlias[] = [];
	const filesById = new Map(input.files.map((file) => [file.id, file]));
	for (const file of input.files) {
		const evidence = fileEvidence(file);
		for (const segment of file.path.split("/")) addTerms(aliases, path.posix.parse(segment).name, file.id, "file-path", evidence);
	}
	for (const symbol of input.symbols) {
		const file = filesById.get(symbol.fileId);
		if (file === undefined) continue;
		const evidence = symbolEvidence(file, symbol);
		for (const value of [symbol.name, symbol.qualifiedName]) if (value !== undefined) addTerms(aliases, value, symbol.id, "symbol", evidence);
		if (symbol.signature !== undefined) addTerms(aliases, symbol.signature, symbol.id, "signature", evidence, true);
	}
	for (const node of input.architecture) {
		const evidence = architectureEvidence(node, filesById, input.architecture);
		const source: RepoMapAliasSource = node.kind === "entrypoint"
			&& (node.entrypointType === "command" || node.entrypointType === "tool" || node.entrypointType === "plugin")
			? "registration"
			: "architecture";
		for (const value of node.kind === "entrypoint" ? [node.name, node.entrypointType, node.declaredTarget] : [node.name, node.rootPath]) {
			if (value !== undefined) addTerms(aliases, value, node.id, source, evidence);
		}
	}
	for (const edge of input.edges) {
		if (edge.lexicalTarget === undefined || edge.evidence.length === 0) continue;
		const source = edge.kind === "imports" ? "import-alias" : "symbol";
		for (const evidence of edge.evidence) addTerms(aliases, edge.lexicalTarget, edge.from, source, evidence);
	}
	aliases.push(...await sourceAliases(input));
	return deduplicateAndLimit(aliases);
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
	return term.split(" ").map((token) => FIXED_EXPANSIONS.get(token) ?? token).join(" ");
}

async function sourceAliases(input: BuildRepoMapLexicalAliasesInput): Promise<RepoMapLexicalAlias[]> {
	const readText = input.readText ?? readTextNoFollow;
	const indexed = input.files.filter((file) => file.status === "indexed" && file.contentHash !== undefined);
	const limit = pLimit(input.concurrency);
	const results = await limit.map(indexed, async (file) => {
			throwIfAborted(input.signal);
			try {
				const text = await readText(path.join(input.root, file.path), input.signal);
				throwIfAborted(input.signal);
				return sha256(text) === file.contentHash ? extractSourceAliases(file, text) : [];
			} catch {
				throwIfAborted(input.signal);
				return [];
			}
	});
	return results.flat();
}

function extractSourceAliases(file: RepoMapFileRecord, text: string): RepoMapLexicalAlias[] {
	const result: RepoMapLexicalAlias[] = [];
	const addMatch = (expression: RegExp, source: RepoMapAliasSource, groups: readonly number[]): void => {
		for (const match of text.matchAll(expression)) {
			const startByte = Buffer.byteLength(text.slice(0, match.index), "utf8");
			const endByte = startByte + Buffer.byteLength(match[0], "utf8");
			const line = 1 + countNewlines(text, match.index);
			const evidence: RepoMapEvidence = { path: file.path, ...(file.contentHash !== undefined ? { textHash: file.contentHash } : {}), startLine: line, endLine: line + countNewlines(match[0], match[0].length), startByte, endByte };
			for (const group of groups) {
				const value = match[group];
				if (value !== undefined) addTerms(result, value, file.id, source, evidence);
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
				for (const value of [pair[1], pair[2]]) if (value !== undefined) addTerms(result, value, file.id, source, evidence);
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
		for (const token of comment[0].match(/[\p{L}][\p{L}\p{N}_-]{3,}/gu) ?? []) addTerms(result, token, file.id, "doc-comment", evidence);
	}
	return result;
}

function addTerms(
	result: RepoMapLexicalAlias[],
	value: string,
	target: string,
	source: RepoMapAliasSource,
	evidence: RepoMapEvidence,
	tokensOnly = false,
): void {
	const terms = lexicalTerms(value);
	for (const term of terms) {
		if (tokensOnly && term.includes(" ")) continue;
		result.push({ term, canonical: canonicalLexicalTerm(term), target, source, confidence: SOURCE_CONFIDENCE[source], evidence: [evidence] });
	}
}

function deduplicateAndLimit(input: readonly RepoMapLexicalAlias[]): RepoMapLexicalAlias[] {
	const unique = new Map<string, RepoMapLexicalAlias>();
	for (const alias of input) {
		const key = [alias.target, alias.term, alias.canonical, alias.source].join("\0");
		const existing = unique.get(key);
		if (existing === undefined) unique.set(key, { ...alias, evidence: [...alias.evidence] });
		else existing.evidence = uniqueRepoMapEvidence([...existing.evidence, ...alias.evidence]);
	}
	const byTarget = groupBy([...unique.values()], (alias) => alias.target);
	return [...byTarget.values()].flatMap((values) => values
		.sort((left, right) => right.confidence - left.confidence || compareText(left.term, right.term) || compareText(left.source, right.source))
		.slice(0, MAX_ALIASES_PER_TARGET))
		.sort(compareAlias);
}

function informative(token: string): boolean {
	return token.length >= 3 && !LOW_INFORMATION.has(token) && !/^\d+$/u.test(token);
}

function architectureEvidence(
	node: RepoMapArchitectureNode,
	files: ReadonlyMap<string, RepoMapFileRecord>,
	architecture: readonly RepoMapArchitectureNode[],
): RepoMapEvidence {
	const owner = node.kind === "entrypoint" && node.packageId !== undefined
		? architecture.find((candidate) => candidate.kind === "package" && candidate.id === node.packageId)
		: undefined;
	const pathValue = node.kind === "package"
		? node.manifestPath
		: node.kind === "entrypoint" && node.source === "manifest" && owner?.kind === "package"
			? owner.manifestPath
			: node.kind === "entrypoint" && node.fileId !== undefined
				? files.get(node.fileId)?.path
				: undefined;
	const file = pathValue === undefined ? undefined : [...files.values()].find((candidate) => candidate.path === pathValue);
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
