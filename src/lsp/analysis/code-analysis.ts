import pLimit from "p-limit";
import type { Position, Range } from "vscode-languageserver-protocol";

import type {
	AnalyzedFileIndex,
	CodeAnalysis,
	CodeAnalysisInput,
	CodeAnalysisTarget,
	CodeAuthority,
	CodeDocument,
	IndexedCodeUnit,
} from "../../code-index/types.js";
import { compareCodeUnitNesting } from "../../code-index/parser.js";
import { LspClient } from "../client/client.js";
import { analyzeLspDocument, type AnalyzedLspDocument, type AnalyzedLspUnit } from "./document.js";
import { featureAvailable, lspFeatureDefinitions } from "../protocol/features.js";
import { createOperationDeadline, waitUnlessAborted, type OperationDeadline } from "./deadline.js";
import {
	resolveWorkspaceSymbolSeeds,
	type ResolvedWorkspaceSymbol,
	type WorkspaceSymbolContext,
} from "./workspace-symbols.js";
import { isExcludedRoot } from "../manager/runtime.js";
import type { LoadedLspConfig, LspFileRoute, LspServerConfig } from "../types.js";
import { pathToFileUri } from "../protocol/uri.js";

const CODE_ANALYSIS_CONCURRENCY = 2;
const CODE_ANALYSIS_SYMBOL_LIMIT = 3;
type NonEmptyArray<T> = [T, ...T[]];

export interface LspCodeAnalysisInput extends Omit<CodeAnalysisInput, "load"> {
	readonly root: string;
	load(path: string): Promise<(CodeDocument & { readonly filePath: string }) | undefined>;
}

export interface LspAnalysisContext extends WorkspaceSymbolContext {
	enabledConfig(root: string): Promise<LoadedLspConfig | undefined>;
	routeForRelativePath(root: string, relativePath: string): LspFileRoute | undefined;
	serversForPaths(root: string, paths: Iterable<string>): LspServerConfig[];
}

/** 编排受路由和超时约束的 LSP code analysis。 */
export async function codeAnalysis(
	context: LspAnalysisContext,
	input: LspCodeAnalysisInput,
): Promise<CodeAnalysis | undefined> {
	const config = await context.enabledConfig(input.root);
	const targetPaths = input.targets.map((target) => target.path);
	if (
		config === undefined
		|| isExcludedRoot(input.root, config.config.exclude_paths)
		|| new Set(targetPaths).size !== targetPaths.length
		|| input.targets.some((target) => !validAnalysisTarget(target))
	) return undefined;
	if (targetPaths.length === 0) return { mode: "symbol", coveredPaths: [], files: [] };
	const routes: Array<{ readonly target: CodeAnalysisTarget; readonly route: LspFileRoute }> = [];
	for (const target of input.targets) {
		const route = context.routeForRelativePath(input.root, target.path);
		if (route === undefined) return undefined;
		routes.push({ target, route });
	}
	const servers = context.serversForPaths(input.root, targetPaths);
	if (servers.length === 0) return undefined;
	const operation = createOperationDeadline(input.signal, config.config.request_timeout_ms);
	try {
		const started = await Promise.all(servers.map(async (server) => ({
			server,
			client: await waitUnlessAborted(context.clientForServer(input.root, server), operation.signal),
		})));
		if (operation.signal.aborted) return undefined;
		const startedClients: Array<{ readonly server: LspServerConfig; readonly client: LspClient }> = [];
		for (const { server, client } of started) {
			if (client === undefined) return undefined;
			startedClients.push({ server, client });
		}
		const clients = new Map(startedClients.map(({ server, client }) => [server.id, client] as const));
		if (startedClients.some(({ client }) =>
			!featureAvailable(client, lspFeatureDefinitions.documentSymbols)
			|| !featureAvailable(client, lspFeatureDefinitions.references)
			|| !featureAvailable(client, lspFeatureDefinitions.incomingCalls)
			|| (input.allowRelated && !featureAvailable(client, lspFeatureDefinitions.workspaceSymbols)))
		) return undefined;

		if (!input.allowRelated) {
			const limit = pLimit(CODE_ANALYSIS_CONCURRENCY);
			const files = await Promise.all(routes.map(({ target, route }) => limit(async () => {
				const client = clients.get(route.server.id);
				return client === undefined
					? undefined
					: analyzeTargetDocument(input, target, client, operation);
			})));
			if (files.some((file) => file === undefined)) return undefined;
			return {
				mode: "symbol",
				coveredPaths: targetPaths,
				files: files.filter((file): file is NonNullable<typeof file> => file !== undefined),
			};
		}
		if (!config.config.grep.workspace_symbols || config.config.grep.max_symbols <= 0) return undefined;
		const allowedPaths = new Set(targetPaths);
		const candidates = await resolveWorkspaceSymbolSeeds(
			{ root: input.root, query: input.query, allowedPaths },
			config,
			operation,
			servers,
			context,
		);
		if (candidates === undefined) return undefined;
		const exact = candidates.filter(({ seed }) => seed.exact);
		const selected = (exact.length > 0 ? exact : candidates)
			.slice(0, Math.min(CODE_ANALYSIS_SYMBOL_LIMIT, input.limit));
		if (selected.length === 0) return { mode: "symbol", coveredPaths: targetPaths, files: [] };
		const byPath = new Map<string, NonEmptyArray<ResolvedWorkspaceSymbol>>();
		for (const item of selected) {
			const grouped = byPath.get(item.seed.path);
			if (grouped === undefined) byPath.set(item.seed.path, [item]);
			else grouped.push(item);
		}
		const limit = pLimit(CODE_ANALYSIS_CONCURRENCY);
		const files = await Promise.all([...byPath.entries()].map(([relativePath, grouped]) => limit(async () => {
			const client = grouped[0].client;
			return analyzeSeedDocument(input, relativePath, grouped, client, operation);
		})));
		const complete = files.filter((file): file is NonNullable<typeof file> => file !== undefined);
		if (complete.length !== byPath.size) return undefined;
		return {
			mode: "symbol",
			coveredPaths: targetPaths,
			files: complete,
		};
	} finally {
		operation.dispose();
	}
}

async function analyzeTargetDocument(
	input: LspCodeAnalysisInput,
	target: CodeAnalysisTarget,
	client: LspClient,
	operation: OperationDeadline,
): Promise<CodeAnalysis["files"][number] | undefined> {
	return analyzeDocumentSelection(
		input,
		target.path,
		client,
		operation,
		(analysis) => unitsForRanges(analysis, target.ranges),
	);
}

async function analyzeSeedDocument(
	input: LspCodeAnalysisInput,
	relativePath: string,
	grouped: readonly ResolvedWorkspaceSymbol[],
	client: LspClient,
	operation: OperationDeadline,
): Promise<CodeAnalysis["files"][number] | undefined> {
	return analyzeDocumentSelection(
		input,
		relativePath,
		client,
		operation,
		(analysis) => {
			const selected = new Map<string, AnalyzedLspUnit>();
			for (const { seed } of grouped) {
				const unit = unitForSeed(analysis, seed);
				if (unit === undefined) return undefined;
				selected.set(unit.unit.id, unit);
			}
			return [...selected.values()];
		},
	);
}

async function analyzeDocumentSelection(
	input: LspCodeAnalysisInput,
	relativePath: string,
	client: LspClient,
	operation: OperationDeadline,
	select: (analysis: AnalyzedLspDocument) => readonly AnalyzedLspUnit[] | undefined,
): Promise<CodeAnalysis["files"][number] | undefined> {
	try {
		const document = await input.load(relativePath);
		if (document === undefined || operation.signal.aborted) return undefined;
		const symbols = await client.documentSymbols(document.filePath, document.text, operation.requestOptions());
		if (symbols === undefined || operation.signal.aborted) return undefined;
		const analyzed = analyzeLspDocument(document, symbols);
		if (analyzed === undefined) return undefined;
		const selected = select(analyzed);
		if (selected === undefined) return undefined;
		const authorityLimit = pLimit(CODE_ANALYSIS_CONCURRENCY);
		const authorities = await Promise.all(selected.map(({ unit, position }) => authorityLimit(async () => {
			const authority = await symbolAuthority(
				client,
				document.filePath,
				position,
				pathToFileUri(document.filePath),
				unit,
				operation,
			);
			return authority === undefined ? undefined : { unit, authority };
		})));
		if (!allDefined<{ readonly unit: IndexedCodeUnit; readonly authority: CodeAuthority }>(authorities)) return undefined;
		return {
			document,
			analysis: withAuthorities(analyzed.analysis, authorities),
		};
	} catch {
		return undefined;
	}
}

async function symbolAuthority(
	client: LspClient,
	filePath: string,
	position: Position,
	documentUri: string,
	unit: IndexedCodeUnit,
	operation: OperationDeadline,
): Promise<CodeAuthority | undefined> {
	const [calls, references] = await Promise.all([
		client.incomingCalls(filePath, position, operation.requestOptions()),
		client.references(filePath, position, operation.requestOptions()),
	]);
	if (calls === undefined || references === undefined) return undefined;
	if (calls.some((call) => outsideUnit(call.from.uri, call.from.range, documentUri, unit))) return "called";
	if (references.some((reference) => outsideUnit(reference.uri, reference.range, documentUri, unit))) return "referenced";
	return "defined";
}

function unitForSeed(analysis: AnalyzedLspDocument, seed: { symbol: string; qualified_symbol?: string; line: number }): AnalyzedLspUnit | undefined {
	const name = normalizeSymbolText(seed.symbol);
	const qualified = seed.qualified_symbol === undefined ? undefined : normalizeSymbolText(seed.qualified_symbol);
	const line = seed.line + 1;
	return [...analysis.units]
		.filter(({ unit }) => {
			const unitName = normalizeSymbolText(unit.name ?? "");
			const unitQualified = unit.qualifiedName === undefined ? undefined : normalizeSymbolText(unit.qualifiedName);
			return unitName === name || (qualified !== undefined && unitQualified === qualified);
		})
		.sort((left, right) =>
			Number(!(left.unit.startLine <= line && line <= left.unit.endLine))
				- Number(!(right.unit.startLine <= line && line <= right.unit.endLine))
			|| Math.abs(left.unit.startLine - line) - Math.abs(right.unit.startLine - line)
			|| (left.unit.endByte - left.unit.startByte) - (right.unit.endByte - right.unit.startByte)
			|| compareString(left.unit.id, right.unit.id))[0];
}

function unitsForRanges(
	analysis: AnalyzedLspDocument,
	ranges: CodeAnalysisTarget["ranges"],
): AnalyzedLspUnit[] {
	const units = [...analysis.units].sort((left, right) => compareCodeUnitNesting(left.unit, right.unit));
	const selected = new Map<string, AnalyzedLspUnit>();
	for (const range of ranges) {
		const unit = units.find((candidate) => candidate.unit.startByte <= range.startByte && range.endByte <= candidate.unit.endByte);
		if (unit !== undefined) selected.set(unit.unit.id, unit);
	}
	return [...selected.values()];
}

function withAuthorities(
	analysis: AnalyzedFileIndex,
	values: readonly { readonly unit: IndexedCodeUnit; readonly authority: CodeAuthority }[],
): AnalyzedFileIndex {
	return {
		...analysis,
		index: {
			...analysis.index,
			units: values.map(({ unit, authority }) => ({ ...unit, authority })),
		},
	};
}

function outsideUnit(uri: string, range: Range, documentUri: string, unit: IndexedCodeUnit): boolean {
	if (uri !== documentUri) return true;
	const startLine = range.start.line + 1;
	const endLine = range.end.line + 1;
	return endLine < unit.startLine || startLine > unit.endLine;
}

function validAnalysisTarget(target: CodeAnalysisTarget): boolean {
	return target.path.length > 0
		&& target.ranges.every((range) =>
			Number.isSafeInteger(range.startByte)
				&& Number.isSafeInteger(range.endByte)
				&& range.startByte >= 0
				&& range.endByte >= range.startByte);
}

function normalizeSymbolText(value: string): string {
	return value.replace(/::|#/gu, ".").toLocaleLowerCase();
}

function compareString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function allDefined<T>(values: readonly (T | undefined)[]): values is readonly T[] {
	return values.every((value) => value !== undefined);
}
