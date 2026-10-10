import pLimit from "p-limit";

import type {
	AnalyzedCodeFile,
	CodeAnalysis,
	CodeAnalysisCoverage,
	CodeAnalysisStatus,
	CodeAnalysisInput,
	CodeAnalysisTarget,
	CodeDocument,
	CodeFeatureResult,
	CodeFileAnalysis,
	IndexedCodeUnit,
} from "../../code-index/types.ts";
import type { CodeRelation } from "../../code-index/relation-types.ts";
import { compareCodeUnitNesting, queryAnchor } from "../../code-index/units.ts";
import { LspClient } from "../client/client.ts";
import type { LspServerConfig } from "../types.ts";
import { analyzeLspDocument } from "./document.ts";
import { resolveWorkspaceSymbolSeeds, type ResolvedWorkspaceSymbol } from "./workspace-symbols.ts";
import type { LspWorkspace } from "../manager/workspace.ts";
import { symbolRelations } from "./symbol-relations.ts";
import { definitionRelations } from "./definition-relations.ts";
import { RelationLocations } from "./relation-locations.ts";
import { SourceIndex } from "../../code-index/source-index.ts";
import { mergeCodeStructure } from "../../code-index/structure.ts";
import { applyRelationEvidence, normalizeRelationEvidence } from "../../code-index/authority.ts";
import { AnalysisRequests } from "./requests.ts";
import { normalizeSymbolText, type WorkspaceSymbolSeed } from "./symbols.ts";

const CODE_ANALYSIS_CONCURRENCY = 2;
const CODE_ANALYSIS_SYMBOL_LIMIT = 3;

interface DocumentSelection {
	readonly file: AnalyzedCodeFile;
	readonly symbols: CodeAnalysisStatus;
	readonly relations: readonly CodeRelation[];
}

interface PendingFileAnalysis extends CodeFileAnalysis {
	readonly relations: readonly CodeRelation[];
}

export interface LspCodeAnalysisInput extends Omit<CodeAnalysisInput, "load"> {
	readonly root: string;
	load(path: string): Promise<(CodeDocument & { readonly filePath: string }) | undefined>;
}

/** 每个目标独立保留结果，关系在全部文件完成后统一归一化。 */
export async function codeAnalysis(workspace: LspWorkspace, input: LspCodeAnalysisInput): Promise<CodeAnalysis | undefined> {
	const targetPaths = input.targets.map((target) => target.path);
	if (input.signal?.aborted === true || new Set(targetPaths).size !== targetPaths.length
		|| input.targets.some((target) => !validAnalysisTarget(target))) return undefined;
	const results = new Map(targetPaths.map((path) => [path, fileResult({ path, symbols: "unsupported" })]));
	const requests = new AnalysisRequests(input.signal, workspace.config.request_timeout_ms);
	const clients = new Map<LspServerConfig, Promise<CodeFeatureResult<LspClient>>>();
	const routes = input.targets.flatMap((target) => {
		const route = workspace.route(target.path);
		if (route === undefined) return [];
		let client = clients.get(route.server);
		if (client === undefined) {
			client = requests.run(true, () => workspace.client(route.server));
			clients.set(route.server, client);
		}
		return [{ target, route, client }];
	});
	let analyzed: PendingFileAnalysis[];
	if (!input.allowRelated) {
		const limit = pLimit(CODE_ANALYSIS_CONCURRENCY);
		analyzed = await limit.map(routes, async ({ target, client: pending }) => {
			const client = await pending;
			const selection = client.status === "ok"
				? await analyzeDocumentSelection(input, target.path, client.value, requests, (units) => unitsForRanges(units, target.ranges))
				: client;
			return selectionResult({ path: target.path, symbols: "unsupported" }, selection);
		});
	} else {
		const ready = await Promise.all([...clients]
			.sort(([left], [right]) => workspace.config.servers.indexOf(left) - workspace.config.servers.indexOf(right))
			.map(async ([server, pending]) => ({ server, result: await pending })));
		for (const { server, result } of ready) {
			if (result.status === "ok") continue;
			for (const { target } of routes.filter(({ route }) => route.server === server)) {
				results.set(target.path, fileResult({ path: target.path, symbols: result.status, workspaceSymbols: result.status }));
			}
		}
		const available = ready.flatMap(({ result }) => result.status === "ok" ? [result.value] : []);
		const owners = new Map(routes.map(({ target, route }) => [target.path, route.server.id]));
		analyzed = await analyzeRelatedDocuments(workspace, input, available, owners, requests);
	}
	for (const result of analyzed) results.delete(result.coverage.path);
	if (requests.signal?.aborted === true) return undefined;
	const relations = normalizeRelationEvidence(analyzed.flatMap((result) => result.relations));
	return {
		relations,
		results: [...analyzed, ...results.values()].map(({ coverage, file }) => ({
			coverage,
			...(file === undefined ? {} : { file: { ...file, analysis: applyRelationEvidence(file.analysis, relations, file.document.hash) } }),
		})),
	};
}

async function analyzeRelatedDocuments(
	workspace: LspWorkspace,
	input: LspCodeAnalysisInput,
	clients: readonly LspClient[],
	owners: ReadonlyMap<string, string>,
	requests: AnalysisRequests,
): Promise<PendingFileAnalysis[]> {
	const config = workspace.config.grep;
	if (!config.workspace_symbols || config.max_symbols <= 0) return [];
	const candidates = await resolveWorkspaceSymbolSeeds({ root: workspace.root, query: input.query, owners }, config, requests, clients);
	const results = new Map([...candidates.coverage].map(([path, status]) => [path, fileResult({ path, symbols: status, workspaceSymbols: status })]));
	const exact = candidates.seeds.filter(({ seed }) => seed.exact);
	const prioritized = exact.length > 0 ? exact : candidates.seeds;
	const selected = prioritized.slice(0, Math.min(CODE_ANALYSIS_SYMBOL_LIMIT, input.limit));
	for (const { seed } of prioritized.slice(selected.length)) {
		const current = results.get(seed.path);
		if (current !== undefined) results.set(seed.path, fileResult({ ...current.coverage, symbols: "skipped" }));
	}
	const byPath = new Map<string, [ResolvedWorkspaceSymbol, ...ResolvedWorkspaceSymbol[]]>();
	for (const item of selected) {
		const grouped = byPath.get(item.seed.path);
		if (grouped === undefined) byPath.set(item.seed.path, [item]);
		else grouped.push(item);
	}
	const limit = pLimit(CODE_ANALYSIS_CONCURRENCY);
	const analyzed = await limit.map(byPath, async ([path, grouped]) => {
		const current = results.get(path);
		if (current === undefined) throw new Error("Missing workspace symbol coverage");
		const selection = await analyzeDocumentSelection(input, path, grouped[0].client, requests, (units) => {
			const selected = new Map<string, IndexedCodeUnit>();
			for (const { seed } of grouped) {
				const unit = unitForSeed(units, seed);
				if (unit === undefined) return undefined;
				selected.set(unit.id, unit);
			}
			return [...selected.values()];
		});
		return selectionResult(current.coverage, selection);
	});
	for (const result of analyzed) results.delete(result.coverage.path);
	return [...analyzed, ...results.values()];
}

/** 仅保留分析事实，候选回退由搜索接纳边界决定。 */
function fileResult(coverage: CodeAnalysisCoverage): PendingFileAnalysis {
	return { coverage, relations: [] };
}

function selectionResult(coverage: CodeAnalysisCoverage, selection: CodeFeatureResult<DocumentSelection>): PendingFileAnalysis {
	if (selection.status !== "ok") return fileResult({ ...coverage, symbols: selection.status });
	const { file, relations, symbols } = selection.value;
	return {
		...fileResult({ ...coverage, symbols: coverage.symbols === "skipped" ? "skipped" : symbols }),
		file, relations,
	};
}

async function analyzeDocumentSelection(
	input: LspCodeAnalysisInput,
	relativePath: string,
	client: LspClient,
	requests: AnalysisRequests,
	select: (units: readonly IndexedCodeUnit[]) => readonly IndexedCodeUnit[] | undefined,
): Promise<CodeFeatureResult<DocumentSelection>> {
	const loaded = await requests.run(true, async (options) => {
		const document = await input.load(relativePath);
		if (document === undefined || options.signal.aborted) return undefined;
		const syntax = await input.syntax(document, options.signal);
		return { document, syntax };
	});
	if (loaded.status !== "ok") return loaded;
	const { document, syntax } = loaded.value;
	const result = await client.withDocument(document.filePath, document.text, input.signal, async (session) => {
		const symbols = await requests.run(session.capabilities()?.documentSymbolProvider, async (options) => {
			const values = await session.symbols(options);
			return values === undefined ? undefined : analyzeLspDocument(document, values, session.uri);
		});
		const analysis = mergeCodeStructure(syntax, symbols.status === "ok" ? symbols.value : undefined);
		const selected = select(analysis.units);
		if (selected === undefined) return undefined;
		const index = new SourceIndex(document.text);
		const locations = new RelationLocations(input, requests, { document, analysis, index });
		const limit = pLimit(CODE_ANALYSIS_CONCURRENCY);
		const enhanced = await limit.map(selected, async (unit) => {
			const position = index.positionForByte(queryAnchor(unit).startByte);
			if (position === undefined) throw new RangeError("Invalid declaration boundary");
			return { id: unit.id, result: await symbolRelations(session, position, unit, locations, requests) };
		});
		const relations = enhanced.flatMap((item) => item.result.relations);
		const definitions = await definitionRelations(session, analysis, selected, relations, locations, requests);
		relations.push(...definitions.relations);
		const statuses = new Map(enhanced.map((item) => [item.id, item.result.status]));
		const selectedIds = new Set(selected.map((unit) => unit.id));
		const byId = new Map(analysis.units.map((unit) => [unit.id, unit]));
		const inSelection = (unit: IndexedCodeUnit): boolean => {
			for (let current: IndexedCodeUnit | undefined = unit; current !== undefined; current = current.parentId === undefined ? undefined : byId.get(current.parentId)) {
				if (selectedIds.has(current.id)) return true;
			}
			return false;
		};
		return { symbols: symbols.status, relations, file: { document, selectedIds: [...selectedIds], analysis: {
			...analysis,
			units: analysis.units.filter((unit) => !input.allowRelated || inSelection(unit))
				.map((unit) => ({ ...unit, relationStatus: {
					...(statuses.get(unit.id) ?? { incomingCalls: "skipped", outgoingCalls: "skipped", references: "skipped" }),
					definitions: definitions.statuses.get(unit.id) ?? "skipped",
					validation: locations.status,
				} })),
		} } };
	});
	return result === undefined ? { status: "unavailable" } : { status: "ok", value: result };
}

function unitForSeed(units: readonly IndexedCodeUnit[], seed: WorkspaceSymbolSeed): IndexedCodeUnit | undefined {
	const name = normalizeSymbolText(seed.symbol);
	const qualified = seed.qualified_symbol === undefined ? undefined : normalizeSymbolText(seed.qualified_symbol);
	const line = seed.range.start.line + 1;
	return units.filter((unit) => {
		const unitName = normalizeSymbolText(unit.name ?? "");
		const unitQualified = unit.qualifiedName === undefined ? undefined : normalizeSymbolText(unit.qualifiedName);
		return unitName === name || (qualified !== undefined && unitQualified === qualified);
	}).sort((left, right) =>
		Number(!(left.startLine <= line && line <= left.endLine)) - Number(!(right.startLine <= line && line <= right.endLine))
		|| Math.abs(left.startLine - line) - Math.abs(right.startLine - line)
		|| (left.endByte - left.startByte) - (right.endByte - right.startByte)
		|| compareString(left.id, right.id))[0];
}

function unitsForRanges(units: readonly IndexedCodeUnit[], ranges: CodeAnalysisTarget["ranges"]): IndexedCodeUnit[] {
	const ordered = [...units].sort(compareCodeUnitNesting);
	const selected = new Map<string, IndexedCodeUnit>();
	for (const range of ranges) {
		const unit = ordered.find((candidate) => candidate.startByte <= range.startByte && range.endByte <= candidate.endByte);
		if (unit !== undefined) selected.set(unit.id, unit);
	}
	return [...selected.values()];
}

function validAnalysisTarget(target: CodeAnalysisTarget): boolean {
	return target.path.length > 0 && target.ranges.every((range) => Number.isSafeInteger(range.startByte)
		&& Number.isSafeInteger(range.endByte) && range.startByte >= 0 && range.endByte >= range.startByte);
}

function compareString(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
