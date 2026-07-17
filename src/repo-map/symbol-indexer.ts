import { createHash } from "node:crypto";
import path from "node:path";
import pLimit from "p-limit";

import { analyzeCodeFile, languageFromPath, type AnalyzedFileIndex } from "../code-index/parser.js";
import { throwIfAborted } from "./errors.js";
import { compareText, groupBy, type RepoMapImportFact, type RepoMapSymbolIndex } from "./graph.js";
import { readTextNoFollow, type RepoMapReadText } from "./source.js";
import type { RepoMapDiagnostic, RepoMapEdge, RepoMapFileRecord, RepoMapSymbolNode } from "./types.js";

export interface IndexRepoMapSymbolsInput {
	root: string;
	files: readonly RepoMapFileRecord[];
	concurrency: number;
	previous?: {
		files: readonly RepoMapFileRecord[];
		symbols: readonly RepoMapSymbolNode[];
		edges: readonly RepoMapEdge[];
		diagnostics: readonly RepoMapDiagnostic[];
	};
	signal?: AbortSignal;
	analyze?: (filePath: string, text: string) => AnalyzedFileIndex;
	readText?: RepoMapReadText;
}

interface FileIndexResult {
	symbols: RepoMapSymbolNode[];
	imports: RepoMapImportFact[];
	diagnostics: RepoMapDiagnostic[];
	status: "parsed" | "unsupported" | "error" | "skipped";
	reused: boolean;
}

export async function indexRepoMapSymbols(input: IndexRepoMapSymbolsInput): Promise<RepoMapSymbolIndex> {
	throwIfAborted(input.signal);
	const analyze = input.analyze ?? analyzeCodeFile;
	const readText = input.readText ?? readTextNoFollow;
	const previousFiles = new Map(input.previous?.files.map((file) => [file.path, file]) ?? []);
	const previousSymbols = groupSymbolsByFile(input.previous?.symbols ?? []);
	const previousImports = groupImportsByFile(input.previous?.edges ?? []);
	const previousErrors = new Set(
		(input.previous?.diagnostics ?? [])
			.filter((diagnostic) => diagnostic.code === "PARSER_ERROR" || diagnostic.code === "FILE_CHANGED_DURING_PARSE")
			.flatMap((diagnostic) => diagnostic.path === undefined ? [] : [diagnostic.path]),
	);
	const limit = pLimit(input.concurrency);
	const results = await limit.map(input.files, async (file) => {
		throwIfAborted(input.signal);
		return await indexFile(file, input.root, previousFiles, previousSymbols, previousImports, previousErrors, analyze, readText, input.signal);
	});
	throwIfAborted(input.signal);

	return {
		symbols: results.flatMap((result) => result.symbols).sort(compareSymbol),
		imports: results.flatMap((result) => result.imports).sort(compareImport),
		diagnostics: results.flatMap((result) => result.diagnostics),
		parsedFileCount: results.filter((result) => result.status === "parsed").length,
		unsupportedFileCount: results.filter((result) => result.status === "unsupported").length,
		parseErrorFileCount: results.filter((result) => result.status === "error").length,
		reusedParsedFileCount: results.filter((result) => result.status === "parsed" && result.reused).length,
	};
}

async function indexFile(
	file: RepoMapFileRecord,
	root: string,
	previousFiles: ReadonlyMap<string, RepoMapFileRecord>,
	previousSymbols: ReadonlyMap<string, RepoMapSymbolNode[]>,
	previousImports: ReadonlyMap<string, RepoMapImportFact[]>,
	previousErrors: ReadonlySet<string>,
	analyze: (filePath: string, text: string) => AnalyzedFileIndex,
	readText: (absolutePath: string, signal?: AbortSignal) => Promise<string>,
	signal?: AbortSignal,
): Promise<FileIndexResult> {
	if (file.status !== "indexed") return { symbols: [], imports: [], diagnostics: [], status: "skipped", reused: false };
	if (languageFromPath(file.path) === "text") {
		return { symbols: [], imports: [], diagnostics: [], status: "unsupported", reused: false };
	}
	const old = previousFiles.get(file.path);
	if (
		old?.status === "indexed"
		&& old.contentHash === file.contentHash
		&& !previousErrors.has(file.path)
	) {
		return {
			symbols: previousSymbols.get(file.id) ?? [],
			imports: previousImports.get(file.id) ?? [],
			diagnostics: [],
			status: "parsed",
			reused: true,
		};
	}
	try {
		throwIfAborted(signal);
		const text = await readText(path.join(root, file.path), signal);
		throwIfAborted(signal);
		if (file.contentHash === undefined || createHash("sha256").update(text).digest("hex") !== file.contentHash) {
			return parseFailure(file.path, "FILE_CHANGED_DURING_PARSE", "File changed after scanning and was not parsed.");
		}
		const analyzed = analyze(file.path, text);
		if (analyzed.status !== "parsed") return parseFailure(file.path, "PARSER_ERROR", "Tree-sitter could not parse this supported file.");
		return {
			symbols: analyzed.index.units.map((unit) => ({
				kind: "symbol",
				id: unit.id,
				fileId: analyzed.index.id,
				symbolKind: unit.kind,
				...(unit.name !== undefined ? { name: unit.name } : {}),
				...(unit.qualifiedName !== undefined ? { qualifiedName: unit.qualifiedName } : {}),
				...(unit.signature !== undefined ? { signature: unit.signature } : {}),
				startLine: unit.startLine,
				endLine: unit.endLine,
				startByte: unit.startByte,
				endByte: unit.endByte,
				definitions: [...unit.definitions],
				references: [...unit.references],
				calls: [...unit.calls],
				imports: [...unit.imports],
			})),
			imports: analyzed.imports.map((item) => ({
				fileId: file.id,
				specifier: item.specifier,
				evidence: { path: file.path, ...(file.contentHash !== undefined ? { textHash: file.contentHash } : {}), ...range(item) },
			})),
			diagnostics: [],
			status: "parsed",
			reused: false,
		};
	} catch (error) {
		throwIfAborted(signal);
		return parseFailure(file.path, "PARSER_ERROR", error instanceof Error ? `File could not be parsed: ${error.message}` : "File could not be parsed.");
	}
}

function parseFailure(pathValue: string, code: string, message: string): FileIndexResult {
	return { symbols: [], imports: [], diagnostics: [{ code, message, path: pathValue }], status: "error", reused: false };
}

function groupSymbolsByFile(symbols: readonly RepoMapSymbolNode[]): Map<string, RepoMapSymbolNode[]> {
	return new Map(groupBy(symbols, (symbol) => symbol.fileId));
}

function groupImportsByFile(edges: readonly RepoMapEdge[]): Map<string, RepoMapImportFact[]> {
	const result = new Map<string, RepoMapImportFact[]>();
	for (const edge of edges) {
		if (edge.kind !== "imports" || edge.lexicalTarget === undefined) continue;
		for (const evidence of edge.evidence) {
			const group = result.get(edge.from) ?? [];
			group.push({ fileId: edge.from, specifier: edge.lexicalTarget, evidence });
			result.set(edge.from, group);
		}
	}
	return result;
}

function range(value: { startLine: number; endLine: number; startByte: number; endByte: number }) {
	return { startLine: value.startLine, endLine: value.endLine, startByte: value.startByte, endByte: value.endByte };
}

function compareSymbol(left: RepoMapSymbolNode, right: RepoMapSymbolNode): number {
	return compareText(left.fileId, right.fileId) || left.startByte - right.startByte || compareText(left.id, right.id);
}

function compareImport(left: RepoMapImportFact, right: RepoMapImportFact): number {
	return compareText(left.fileId, right.fileId) || left.evidence.startByte - right.evidence.startByte || compareText(left.specifier, right.specifier);
}
