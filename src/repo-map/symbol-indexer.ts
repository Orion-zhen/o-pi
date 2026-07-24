import { createHash } from "node:crypto";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import pLimit from "p-limit";

import { analyzeCodeFile, languageFromPath, type AnalyzedFileIndex } from "../code-index/parser.js";
import { WorkerTaskAbortedError, WorkerTaskPool } from "../file-tools/core/worker-task-pool.js";
import { createTypeScriptWorker } from "../file-tools/core/typescript-worker.js";
import { javascriptSyntaxFactsFromDocument, type JavaScriptSyntaxFacts } from "./syntax-facts.js";
import { throwIfAborted } from "./errors.js";
import { compareText, groupBy, type RepoMapImportFact, type RepoMapSymbolIndex } from "./graph.js";
import { readTextNoFollow, RepoMapReadLimitError, type RepoMapReadText } from "./source.js";
import type { RepoMapDiagnostic, RepoMapEdge, RepoMapFileRecord, RepoMapSymbolNode } from "./types.js";
import { PARSER_SYNTAX_DIAGNOSTIC, type RepoMapParserFileResult } from "./parser-task.js";

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
	workerFactory?: () => Worker;
}

export interface RepoMapParseWorkload {
	fileCount: number;
	totalBytes: number;
	maxFileBytes: number;
}

export interface RepoMapParseDecisionOptions {
	concurrency?: number;
	workerWarm?: boolean;
}

export const REPO_MAP_PARSER_BATCH_SIZE = 16;

const LOCAL_PARSE_FILE_MS = 0.5;
const LOCAL_PARSE_BYTES_PER_MS = 3_000;
const WORKER_TRANSFER_FILE_MS = 0.15;
const WORKER_TRANSFER_BYTES_PER_MS = 120_000;
const COLD_WORKER_START_MS = 120;
const WARM_WORKER_START_MS = 4;
const LARGE_FILE_BYTES = 256 * 1024;

type RepoMapWorkerPool = WorkerTaskPool<RepoMapWorkerRequest, RepoMapParserFileResult[]>;
interface RepoMapWorkerRequest {
	root: string;
	files: RepoMapFileRecord[];
}

interface FileIndexResult {
	fileId?: string;
	symbols: RepoMapSymbolNode[];
	imports: RepoMapImportFact[];
	diagnostics: RepoMapDiagnostic[];
	status: "parsed" | "unsupported" | "error" | "skipped";
	reused: boolean;
	syntaxFacts?: JavaScriptSyntaxFacts;
}

/** 按文件数、字节量和最大文件大小估算 Repo Map 是否应 offload 到 worker。 */
export function shouldOffloadRepoMapParsing(workload: RepoMapParseWorkload, options: RepoMapParseDecisionOptions = {}): boolean {
	if (workload.fileCount <= 0 || workload.totalBytes <= 0) return false;
	if (workload.maxFileBytes >= LARGE_FILE_BYTES) return true;
	const concurrency = Math.max(1, options.concurrency ?? 1);
	const workers = Math.min(concurrency, Math.ceil(workload.fileCount / REPO_MAP_PARSER_BATCH_SIZE));
	if (workers <= 1) return false;
	const localMs = workload.fileCount * LOCAL_PARSE_FILE_MS + workload.totalBytes / LOCAL_PARSE_BYTES_PER_MS;
	const transferMs = workload.fileCount * WORKER_TRANSFER_FILE_MS + workload.totalBytes / WORKER_TRANSFER_BYTES_PER_MS;
	const startupMs = (options.workerWarm ?? false) ? WARM_WORKER_START_MS : COLD_WORKER_START_MS;
	return startupMs + localMs / workers + transferMs < localMs;
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
			.filter((diagnostic) => diagnostic.code === "PARSER_ERROR" || diagnostic.code === "PARSER_SYNTAX_ERROR" || diagnostic.code === "FILE_CHANGED_DURING_PARSE")
			.flatMap((diagnostic) => diagnostic.path === undefined ? [] : [diagnostic.path]),
	);
	const workerResults = await parseWithWorkersIfUseful(input, previousFiles, previousErrors);
	const limit = pLimit(input.concurrency);
	const results = await limit.map(input.files, async (file) => {
		throwIfAborted(input.signal);
		const workerResult = workerResults?.get(file.path);
		return await indexFile(file, input.root, previousFiles, previousSymbols, previousImports, previousErrors, analyze, readText, input.signal, workerResult);
	});
	throwIfAborted(input.signal);

	const facts = results
		.filter((result): result is FileIndexResult & { fileId: string; syntaxFacts: JavaScriptSyntaxFacts } => result.fileId !== undefined && result.syntaxFacts !== undefined)
		.sort((left, right) => compareText(left.fileId, right.fileId));
	return {
		symbols: results.flatMap((result) => result.symbols).sort(compareSymbol),
		imports: results.flatMap((result) => result.imports).sort(compareImport),
		diagnostics: results.flatMap((result) => result.diagnostics),
		parsedFileCount: results.filter((result) => result.status === "parsed").length,
		unsupportedFileCount: results.filter((result) => result.status === "unsupported").length,
		parseErrorFileCount: results.filter((result) => result.status === "error").length,
		reusedParsedFileCount: results.filter((result) => result.status === "parsed" && result.reused).length,
		syntaxFactsByFile: new Map(facts.map((result) => [result.fileId, result.syntaxFacts])),
	};
}

async function parseWithWorkersIfUseful(
	input: IndexRepoMapSymbolsInput,
	previousFiles: ReadonlyMap<string, RepoMapFileRecord>,
	previousErrors: ReadonlySet<string>,
): Promise<ReadonlyMap<string, RepoMapParserFileResult> | undefined> {
	if (input.analyze !== undefined || input.readText !== undefined) return undefined;
	const candidates = input.files.filter((file) => isWorkerCandidate(file) && !canReuse(file, previousFiles, previousErrors));
	const workload = workloadFor(candidates);
	if (!shouldOffloadRepoMapParsing(workload, { concurrency: input.concurrency })) return undefined;
	const pool = createRepoMapParserPool(input.concurrency, input.workerFactory);
	try {
		const batches = chunk(candidates, REPO_MAP_PARSER_BATCH_SIZE);
		const responses = await Promise.all(batches.map((files) => pool.run({ root: input.root, files: [...files] }, input.signal)));
		return new Map(responses.flat().map((result) => [result.file.path, result]));
	} catch (error) {
		if (input.signal?.aborted === true || error instanceof WorkerTaskAbortedError) {
			throwIfAborted(input.signal);
		}
		// Worker creation/crash is deliberately transparent: the caller reruns the same files locally.
		return undefined;
	} finally {
		pool.dispose();
	}
}

function createRepoMapParserPool(concurrency: number, workerFactory: (() => Worker) | undefined): RepoMapWorkerPool {
	return new WorkerTaskPool<RepoMapWorkerRequest, RepoMapParserFileResult[]>({
		workerLimit: Math.max(1, concurrency),
		createWorker: workerFactory ?? (() => createTypeScriptWorker(new URL("./parser-worker.ts", import.meta.url))),
		workerName: "Repo Map parser",
		requestForTask: (id, request) => ({ id, ...request }),
		decodeResponse: decodeRepoMapParserResponse,
	});
}

function decodeRepoMapParserResponse(message: unknown): { id: number; result?: RepoMapParserFileResult[]; error?: string } | undefined {
	if (!isRecord(message) || typeof message.id !== "number") return undefined;
	if (Array.isArray(message.results)) return { id: message.id, result: message.results as RepoMapParserFileResult[] };
	return typeof message.error === "string" ? { id: message.id, error: message.error } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function indexFile(
	file: RepoMapFileRecord,
	root: string,
	previousFiles: ReadonlyMap<string, RepoMapFileRecord>,
	previousSymbols: ReadonlyMap<string, RepoMapSymbolNode[]>,
	previousImports: ReadonlyMap<string, RepoMapImportFact[]>,
	previousErrors: ReadonlySet<string>,
	analyze: (filePath: string, text: string) => AnalyzedFileIndex,
	readText: RepoMapReadText,
	signal?: AbortSignal,
	workerResult?: RepoMapParserFileResult,
): Promise<FileIndexResult> {
	if (file.status !== "indexed") return { symbols: [], imports: [], diagnostics: [], status: "skipped", reused: false };
	if (languageFromPath(file.path) === "text") {
		return { symbols: [], imports: [], diagnostics: [], status: "unsupported", reused: false };
	}
	if (canReuse(file, previousFiles, previousErrors)) {
		return {
			symbols: previousSymbols.get(file.id) ?? [],
			imports: previousImports.get(file.id) ?? [],
			diagnostics: [],
			status: "parsed",
			reused: true,
		};
	}
	if (workerResult !== undefined) return resultFromWorker(file, workerResult);
	try {
		throwIfAborted(signal);
		const text = await readText(path.join(root, file.path), signal, file.size);
		throwIfAborted(signal);
		if (file.contentHash === undefined || createHash("sha256").update(text).digest("hex") !== file.contentHash) {
			return parseFailure(file.path, "FILE_CHANGED_DURING_PARSE", "File changed after scanning and was not parsed.");
		}
		const analyzed = analyze(file.path, text);
		if (analyzed.status !== "parsed") return parseFailure(file.path, "PARSER_ERROR", analyzed.failure?.message ?? "Tree-sitter could not parse this supported file.");
		const syntaxFacts = analyzed.document !== undefined && isJavaScriptFamily(file.path)
			? javascriptSyntaxFactsFromDocument(file.path, analyzed.document)
			: undefined;
		return parsedResult(file, analyzed, syntaxFacts, analyzed.document?.root.hasError === true ? PARSER_SYNTAX_DIAGNOSTIC : undefined);
	} catch (error) {
		throwIfAborted(signal);
		if (error instanceof RepoMapReadLimitError) return parseFailure(file.path, "FILE_CHANGED_DURING_PARSE", "File changed after scanning and was not parsed.");
		return parseFailure(file.path, "PARSER_ERROR", error instanceof Error ? `File could not be parsed: ${error.message}` : "File could not be parsed.");
	}
}

function resultFromWorker(file: RepoMapFileRecord, result: RepoMapParserFileResult): FileIndexResult {
	if (result.status === "unsupported") return { symbols: [], imports: [], diagnostics: [], status: "unsupported", reused: false };
	if (result.status === "error" || result.index === undefined) {
		return parseFailure(file.path, result.diagnostic?.code ?? "PARSER_ERROR", result.diagnostic?.message ?? "Tree-sitter could not parse this supported file.");
	}
	return parsedResult(file, { index: result.index, imports: result.imports ?? [] }, result.syntaxFacts, result.diagnostic);
}

function parsedResult(
	file: RepoMapFileRecord,
	analyzed: Pick<AnalyzedFileIndex, "index" | "imports">,
	syntaxFacts: JavaScriptSyntaxFacts | undefined,
	diagnostic?: Pick<RepoMapDiagnostic, "code" | "message">,
): FileIndexResult {
	const result: FileIndexResult = {
		fileId: file.id,
		symbols: analyzed.index.units.map((unit) => ({
			kind: "symbol",
			id: unit.id,
			fileId: analyzed.index.id,
			symbolKind: unit.kind,
			...(unit.name !== undefined ? { name: unit.name } : {}),
			...(unit.qualifiedName !== undefined ? { qualifiedName: unit.qualifiedName } : {}),
			...(unit.signature !== undefined ? { signature: unit.signature } : {}),
			exported: unit.exported,
			startLine: unit.startLine,
			endLine: unit.endLine,
			startByte: unit.startByte,
			endByte: unit.endByte,
			definitions: [...unit.definitions],
			references: [...unit.references],
			calls: [...unit.calls],
		})),
		imports: analyzed.imports.map((item) => ({
			fileId: file.id,
			specifier: item.specifier,
			...(item.importKind !== undefined ? { importKind: item.importKind } : {}),
			evidence: { path: file.path, ...(file.contentHash !== undefined ? { textHash: file.contentHash } : {}), ...range(item) },
		})),
		diagnostics: diagnostic === undefined ? [] : [{ ...diagnostic, path: file.path }],
		status: "parsed",
		reused: false,
	};
	return syntaxFacts === undefined ? result : { ...result, syntaxFacts };
}

function canReuse(file: RepoMapFileRecord, previousFiles: ReadonlyMap<string, RepoMapFileRecord>, previousErrors: ReadonlySet<string>): boolean {
	const old = previousFiles.get(file.path);
	return old?.status === "indexed"
		&& old.contentHash === file.contentHash
		&& !previousErrors.has(file.path);
}

function isWorkerCandidate(file: RepoMapFileRecord): boolean {
	return file.status === "indexed" && languageFromPath(file.path) !== "text";
}

function workloadFor(files: readonly RepoMapFileRecord[]): RepoMapParseWorkload {
	return {
		fileCount: files.length,
		totalBytes: files.reduce((total, file) => total + file.size, 0),
		maxFileBytes: files.reduce((maximum, file) => Math.max(maximum, file.size), 0),
	};
}

function chunk<T>(values: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
	return result;
}

function isJavaScriptFamily(filePath: string): boolean {
	return /\.(?:[cm]?js|jsx|tsx?)$/u.test(filePath);
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
			group.push({ fileId: edge.from, specifier: edge.lexicalTarget, ...(edge.importKind !== undefined ? { importKind: edge.importKind } : {}), evidence });
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
	return compareText(left.fileId, right.fileId)
		|| left.evidence.startByte - right.evidence.startByte
		|| compareText(left.specifier, right.specifier)
		|| compareText(left.importKind ?? "", right.importKind ?? "");
}
