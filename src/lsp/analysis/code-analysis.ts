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
import { compareCodeUnitNesting } from "../../code-index/units.js";
import { LspClient } from "../client/client.js";
import { analyzeLspDocument, type AnalyzedLspDocument, type AnalyzedLspUnit } from "./document.js";
import { supportsCodeAnalysis } from "../protocol/features.js";
import { createOperationDeadline, waitUnlessAborted, type OperationDeadline } from "./deadline.js";
import {
	resolveWorkspaceSymbolSeeds,
	type ResolvedWorkspaceSymbol,
} from "./workspace-symbols.js";
import type { LspWorkspace } from "../manager/workspace.js";
import type { LspFileRoute } from "../types.js";
import { pathToFileUri } from "../protocol/uri.js";
import { normalizeSymbolText, type WorkspaceSymbolSeed } from "./symbols.js";

const CODE_ANALYSIS_CONCURRENCY = 2;
const CODE_ANALYSIS_SYMBOL_LIMIT = 3;
type NonEmptyArray<T> = [T, ...T[]];

export interface LspCodeAnalysisInput extends Omit<CodeAnalysisInput, "load"> {
	readonly root: string;
	load(path: string): Promise<(CodeDocument & { readonly filePath: string }) | undefined>;
}

/** 编排受路由和超时约束的 LSP code analysis。 */
export async function codeAnalysis(
	workspace: LspWorkspace,
	input: LspCodeAnalysisInput,
): Promise<CodeAnalysis | undefined> {
	const config = workspace.config;
	const targetPaths = input.targets.map((target) => target.path);
	if (
		new Set(targetPaths).size !== targetPaths.length
		|| input.targets.some((target) => !validAnalysisTarget(target))
	) return undefined;
	if (targetPaths.length === 0) return { mode: "symbol", coveredPaths: [], files: [] };
	const routes: Array<{ readonly target: CodeAnalysisTarget; readonly route: LspFileRoute }> = [];
	for (const target of input.targets) {
		const route = workspace.route(target.path);
		if (route === undefined) return undefined;
		routes.push({ target, route });
	}
	const selectedServers = new Set(routes.map(({ route }) => route.server));
	const servers = config.servers.filter((server) => selectedServers.has(server));
	if (servers.length === 0) return undefined;
	const operation = createOperationDeadline(input.signal, config.request_timeout_ms);
	try {
		const started = await Promise.all(servers.map((server) => waitUnlessAborted(workspace.client(server), operation.signal)));
		if (operation.signal.aborted || !allDefined(started)) return undefined;
		if (started.some((client) => !supportsCodeAnalysis(client.capabilities(), input.allowRelated))) return undefined;
		const clients = new Map(started.map((client) => [client.server.id, client]));

		if (!input.allowRelated) {
			const limit = pLimit(CODE_ANALYSIS_CONCURRENCY);
			const files = await Promise.all(routes.map(({ target, route }) => limit(async () => {
				const client = clients.get(route.server.id);
				return client === undefined
					? undefined
					: analyzeTargetDocument(input, target, client, operation);
			})));
			if (!allDefined(files)) return undefined;
			return { mode: "symbol", coveredPaths: targetPaths, files };
		}
		if (!config.grep.workspace_symbols || config.grep.max_symbols <= 0) return undefined;
		const owners = new Map(routes.map(({ target, route }) => [target.path, route.server.id]));
		const candidates = await resolveWorkspaceSymbolSeeds(
			{ root: workspace.root, query: input.query, owners },
			config.grep,
			operation,
			started,
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
		if (!allDefined(files)) return undefined;
		return { mode: "symbol", coveredPaths: targetPaths, files };
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

function unitForSeed(analysis: AnalyzedLspDocument, seed: WorkspaceSymbolSeed): AnalyzedLspUnit | undefined {
	const name = normalizeSymbolText(seed.symbol);
	const qualified = seed.qualified_symbol === undefined ? undefined : normalizeSymbolText(seed.qualified_symbol);
	const line = seed.range.start.line + 1;
	return [...analysis.units]
		.filter(({ unit }) => {
			const unitName = normalizeSymbolText(unit.name);
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
		units: values.map(({ unit, authority }) => ({ ...unit, authority })),
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

function compareString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function allDefined<T>(values: (T | undefined)[]): values is T[] {
	return values.every((value) => value !== undefined);
}
