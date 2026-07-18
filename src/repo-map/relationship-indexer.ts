import path from "node:path";

import { languageFromPath } from "../code-index/parser.js";
import { coalesceRepoMapEdges, groupBy, type RepoMapImportFact } from "./graph.js";
import { fileEvidence, symbolEvidence } from "./source.js";
import type { RepoMapEdge, RepoMapEvidence, RepoMapFileRecord, RepoMapSymbolNode } from "./types.js";

export interface BuildRepoMapRelationshipsInput {
	mapId: string;
	files: readonly RepoMapFileRecord[];
	symbols: readonly RepoMapSymbolNode[];
	imports: readonly RepoMapImportFact[];
	previous?: {
		files: readonly RepoMapFileRecord[];
		symbols: readonly RepoMapSymbolNode[];
		edges: readonly RepoMapEdge[];
	};
}

interface ResolvedTarget {
	to: string;
	resolution: RepoMapEdge["resolution"];
	confidence: number;
}

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"];
const RESERVED_WORDS = new Set([
	"as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "defer", "do", "else", "enum",
	"export", "extends", "false", "finally", "fn", "for", "from", "func", "function", "if", "impl", "import", "in", "interface",
	"let", "match", "mod", "new", "none", "null", "package", "pass", "pub", "return", "self", "static", "struct", "super",
	"this", "throw", "trait", "true", "try", "type", "undefined", "use", "var", "while", "with", "yield",
]);

export function buildRepoMapRelationships(input: BuildRepoMapRelationshipsInput): RepoMapEdge[] {
	const filesById = new Map(input.files.map((file) => [file.id, file]));
	const filesByPath = new Map(input.files.map((file) => [file.path, file]));
	const symbolsByName = symbolLookup(input.symbols);
	const reusableSymbolRelations = reusableRelationshipSymbols(input, symbolsByName);
	const previousRelations = groupBy(
		(input.previous?.edges ?? []).filter((edge) => edge.kind === "calls" || edge.kind === "references"),
		(edge) => edge.from,
	);
	const edges: RepoMapEdge[] = [];
	const repositoryId = `repository:${input.mapId}`;

	for (const file of input.files) {
		edges.push({
			from: repositoryId,
			to: file.id,
			kind: "contains",
			resolution: "syntactic",
			source: "convention",
			confidence: 1,
			evidence: [fileEvidence(file)],
		});
	}
	for (const symbol of input.symbols) {
		const file = filesById.get(symbol.fileId);
		if (file === undefined) continue;
		const evidence = symbolEvidence(file, symbol);
		edges.push({
			from: file.id,
			to: symbol.id,
			kind: "contains",
			resolution: "syntactic",
			source: "tree-sitter",
			confidence: 1,
			evidence: [evidence],
		});
		if (isExported(file.path, symbol)) {
			edges.push({
				from: file.id,
				to: symbol.id,
				kind: "exports",
				resolution: "syntactic",
				source: exportSource(file.path),
				confidence: exportConfidence(file.path),
				evidence: [evidence],
			});
		}
		if (reusableSymbolRelations.has(symbol.id)) {
			edges.push(...previousRelations.get(symbol.id) ?? []);
		} else {
			const calls = new Set(symbol.calls.filter((target) => target !== symbol.name && target !== symbol.qualifiedName));
			for (const target of calls) addSymbolRelation(edges, "calls", symbol, target, evidence, symbolsByName);
			for (const target of symbol.references) {
				if (!shouldIndexReference(symbol, target, calls, symbolsByName)) continue;
				addSymbolRelation(edges, "references", symbol, target, evidence, symbolsByName);
			}
		}
	}
	for (const item of input.imports) {
		const importer = filesById.get(item.fileId);
		if (importer === undefined) continue;
		const resolved = resolveImport(importer.path, item.specifier, filesByPath);
		edges.push({
			from: item.fileId,
			to: resolved.to,
			kind: "imports",
			resolution: resolved.resolution,
			source: "tree-sitter",
			confidence: resolved.confidence,
			lexicalTarget: item.specifier,
			evidence: [item.evidence],
		});
	}
	return coalesceRepoMapEdges(edges);
}

function reusableRelationshipSymbols(
	input: BuildRepoMapRelationshipsInput,
	currentLookup: ReadonlyMap<string, RepoMapSymbolNode[]>,
): Set<string> {
	const previous = input.previous;
	if (previous === undefined || previous.files.length !== input.files.length) return new Set();
	const oldFiles = new Map(previous.files.map((file) => [file.path, file]));
	if (input.files.some((file) => oldFiles.get(file.path)?.id !== file.id)) return new Set();
	const unchangedFiles = new Set(input.files.filter((file) => {
		const old = oldFiles.get(file.path);
		return old?.status === file.status && old.contentHash === file.contentHash;
	}).map((file) => file.id));
	const previousSymbols = new Map(previous.symbols.map((symbol) => [symbol.id, symbol]));
	const changedLookupKeys = changedSymbolLookupKeys(symbolLookup(previous.symbols), currentLookup);
	return new Set(input.symbols.filter((symbol) => {
		if (!unchangedFiles.has(symbol.fileId) || !previousSymbols.has(symbol.id)) return false;
		return [...symbol.calls, ...symbol.references].every((target) => {
			const shortName = target.includes(".") ? target.slice(target.lastIndexOf(".") + 1) : target;
			return !changedLookupKeys.has(target) && !changedLookupKeys.has(shortName);
		});
	}).map((symbol) => symbol.id));
}

function changedSymbolLookupKeys(
	previous: ReadonlyMap<string, RepoMapSymbolNode[]>,
	current: ReadonlyMap<string, RepoMapSymbolNode[]>,
): Set<string> {
	const keys = new Set([...previous.keys(), ...current.keys()]);
	return new Set([...keys].filter((key) => symbolIds(previous.get(key)).join("\0") !== symbolIds(current.get(key)).join("\0")));
}

function symbolIds(symbols: readonly RepoMapSymbolNode[] | undefined): string[] {
	return (symbols ?? []).map((symbol) => symbol.id).sort();
}

function addSymbolRelation(
	edges: RepoMapEdge[],
	kind: "references" | "calls",
	from: RepoMapSymbolNode,
	lexicalTarget: string,
	evidence: RepoMapEvidence,
	lookup: ReadonlyMap<string, RepoMapSymbolNode[]>,
): void {
	const resolved = resolveSymbol(from, lexicalTarget, lookup);
	edges.push({
		from: from.id,
		to: resolved.to,
		kind,
		resolution: resolved.resolution,
		source: "tree-sitter",
		confidence: resolved.confidence,
		lexicalTarget,
		evidence: [evidence],
	});
}

function resolveSymbol(from: RepoMapSymbolNode, lexicalTarget: string, lookup: ReadonlyMap<string, RepoMapSymbolNode[]>): ResolvedTarget {
	const exact = lookup.get(lexicalTarget) ?? [];
	const shortName = lexicalTarget.includes(".") ? lexicalTarget.slice(lexicalTarget.lastIndexOf(".") + 1) : lexicalTarget;
	const candidates = exact.length > 0 ? exact : lookup.get(shortName) ?? [];
	const sameFile = candidates.filter((candidate) => candidate.fileId === from.fileId);
	const scoped = from.qualifiedName?.includes(".") === true
		? candidates.filter((candidate) => candidate.qualifiedName === `${from.qualifiedName?.slice(0, from.qualifiedName.lastIndexOf("."))}.${shortName}`)
		: [];
	const selected = unique(scoped) ?? unique(sameFile) ?? unique(candidates);
	if (selected !== undefined) return { to: selected.id, resolution: "lexical", confidence: scoped.includes(selected) ? 0.9 : sameFile.includes(selected) ? 0.82 : 0.72 };
	return { to: `lexical:symbol:${encodeURIComponent(lexicalTarget)}`, resolution: "lexical", confidence: candidates.length > 1 ? 0.35 : 0.25 };
}

function resolveImport(importerPath: string, specifier: string, filesByPath: ReadonlyMap<string, RepoMapFileRecord>): ResolvedTarget {
	for (const candidate of importCandidates(importerPath, specifier)) {
		const file = filesByPath.get(candidate);
		if (file !== undefined) return { to: file.id, resolution: "syntactic", confidence: 0.92 };
	}
	return { to: `external:${encodeURIComponent(specifier)}`, resolution: "lexical", confidence: specifier.startsWith(".") ? 0.4 : 0.6 };
}

function importCandidates(importerPath: string, specifier: string): string[] {
	if (!specifier.startsWith(".")) return [];
	const base = path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), specifier));
	const candidates = [base];
	if (path.posix.extname(base) === "") {
		for (const extension of CODE_EXTENSIONS) candidates.push(`${base}${extension}`, `${base}/index${extension}`);
	}
	return candidates;
}

function symbolLookup(symbols: readonly RepoMapSymbolNode[]): Map<string, RepoMapSymbolNode[]> {
	const entries = symbols.flatMap((symbol) =>
		[...new Set([symbol.name, symbol.qualifiedName].filter((value): value is string => value !== undefined))]
			.map((name) => ({ name, symbol })));
	return new Map(Array.from(groupBy(entries, (item) => item.name), ([name, items]) => [name, items.map((item) => item.symbol)]));
}

function shouldIndexReference(
	from: RepoMapSymbolNode,
	target: string,
	calls: ReadonlySet<string>,
	lookup: ReadonlyMap<string, RepoMapSymbolNode[]>,
): boolean {
	if (target.length < 2 || RESERVED_WORDS.has(target.toLocaleLowerCase()) || calls.has(target)) return false;
	if (target === from.name || target === from.qualifiedName) return false;
	return lookup.has(target) || /^[A-Z_$]/u.test(target);
}

function isExported(filePath: string, symbol: RepoMapSymbolNode): boolean {
	const language = languageFromPath(filePath);
	const topLevel = symbol.qualifiedName === symbol.name;
	if (!topLevel || symbol.name === undefined) return false;
	if (language === "typescript" || language === "tsx" || language === "javascript" || language === "jsx") {
		return /^export\b/u.test(symbol.signature ?? "");
	}
	if (language === "python") return !symbol.name.startsWith("_");
	if (language === "go") return /^\p{Lu}/u.test(symbol.name);
	if (language === "rust") return /^pub(?:\([^)]*\))?\s/u.test(symbol.signature ?? "");
	return false;
}

function exportSource(filePath: string): RepoMapEdge["source"] {
	const language = languageFromPath(filePath);
	return language === "python" || language === "go" ? "convention" : "tree-sitter";
}

function exportConfidence(filePath: string): number {
	return exportSource(filePath) === "tree-sitter" ? 0.95 : 0.75;
}

function unique(values: readonly RepoMapSymbolNode[]): RepoMapSymbolNode | undefined {
	return values.length === 1 ? values[0] : undefined;
}
