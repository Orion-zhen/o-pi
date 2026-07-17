import { createHash } from "node:crypto";
import { CODE_INDEX_FORMAT_VERSION } from "../code-index/identity.js";
import { ignoreConfigFromFileTools, loadFileToolsConfig, type FileToolsConfig } from "../file-tools/config.js";
import { isFailed } from "../file-tools/core/errors.js";
import { createIgnoreSnapshot } from "../file-tools/ignore/ignore-engine.js";
import type { IgnoreSnapshot } from "../file-tools/ignore/ignore-types.js";
import { loadRepoMapConfig, repoMapCacheRoot, repoMapConfigFingerprint, type RepoMapConfig } from "./config.js";
import type { BuildRepoMapArchitectureInput, RepoMapArchitectureIndex } from "./architecture-indexer.js";
import { RepoMapError, throwIfAborted } from "./errors.js";
import { createRepoMapId, REPO_MAP_SCHEMA_VERSION } from "./identity.js";
import type { BuildRepoMapRelationshipsInput } from "./relationship-indexer.js";
import type { BuildRepoMapLexicalAliasesInput } from "./lexical-indexer.js";
import { detectRepository, readHeadRevision, type RepositoryIdentity } from "./repository.js";
import { scanRepoMap, type RepoMapProgress, type RepoMapScanInput, type RepoMapScanResult } from "./scanner.js";
import type { IndexRepoMapSymbolsInput } from "./symbol-indexer.js";
import type { BuildRepoMapTestGraphInput, RepoMapTestGraph } from "./test-indexer.js";
import {
	calculateGeneration,
	commitGeneration,
	readCurrentGeneration,
	readGeneration,
	type CommitGenerationInput,
	type CommitGenerationResult,
	type RepoMapGeneration,
} from "./storage.js";
import type { RepoMapEdge, RepoMapFreshness, RepoMapMetadata, RepoMapScanSummary } from "./types.js";
import { compareRepoMapEdge, type RepoMapSymbolIndex } from "./graph-types.js";
import type { RepoMapActivation } from "./activation.js";

export interface InitializeRepoMapInput {
	cwd: string;
	mode?: "refresh" | "rebuild";
	signal?: AbortSignal;
	onProgress?: (progress: RepoMapProgress) => void;
}

export interface InitializeRepoMapResult {
	identity: RepositoryIdentity;
	metadata: RepoMapMetadata;
	summary: RepoMapScanSummary;
	reusedGeneration: boolean;
}

export interface RepoMapServiceDependencies {
	detectRepository(cwd: string, options: { signal?: AbortSignal }): Promise<RepositoryIdentity>;
	readHeadRevision(root: string, options: { signal?: AbortSignal }): Promise<string | undefined>;
	loadRepoMapConfig(): Promise<RepoMapConfig>;
	loadFileToolsConfig(root: string): Promise<FileToolsConfig>;
	createIgnoreSnapshot(root: string, config: ReturnType<typeof ignoreConfigFromFileTools>): Promise<IgnoreSnapshot>;
	scan(input: RepoMapScanInput): Promise<RepoMapScanResult>;
	indexSymbols(input: IndexRepoMapSymbolsInput): Promise<RepoMapSymbolIndex>;
	buildArchitecture(input: BuildRepoMapArchitectureInput): Promise<RepoMapArchitectureIndex>;
	buildTestGraph(input: BuildRepoMapTestGraphInput): Promise<RepoMapTestGraph>;
	buildRelationships(input: BuildRepoMapRelationshipsInput): Promise<RepoMapEdge[]>;
	buildLexicalAliases(input: BuildRepoMapLexicalAliasesInput): Promise<RepoMapGeneration["aliases"]>;
	readCurrent(cacheRoot: string, mapId: string, expectedRoot: string): Promise<RepoMapGeneration | undefined>;
	commit(input: CommitGenerationInput): Promise<CommitGenerationResult>;
	cacheRoot(): string;
	now(): Date;
}

const defaultDependencies: RepoMapServiceDependencies = {
	detectRepository: async (cwd, options) => await detectRepository(cwd, options),
	readHeadRevision: async (root, options) => await readHeadRevision(root, options),
	loadRepoMapConfig,
	async loadFileToolsConfig(root) {
		const result = await loadFileToolsConfig(root);
		if (isFailed(result)) throw new RepoMapError("CONFIG_ERROR", result.error.message, result.error.details);
		return result;
	},
	createIgnoreSnapshot,
	scan: scanRepoMap,
	async indexSymbols(input) {
		return await (await import("./symbol-indexer.js")).indexRepoMapSymbols(input);
	},
	async buildRelationships(input) {
		return (await import("./relationship-indexer.js")).buildRepoMapRelationships(input);
	},
	async buildArchitecture(input) {
		return await (await import("./architecture-indexer.js")).buildRepoMapArchitecture(input);
	},
	async buildTestGraph(input) {
		return await (await import("./test-indexer.js")).buildRepoMapTestGraph(input);
	},
	async buildLexicalAliases(input) {
		return await (await import("./lexical-indexer.js")).buildRepoMapLexicalAliases(input);
	},
	readCurrent: readCurrentGeneration,
	commit: commitGeneration,
	cacheRoot: repoMapCacheRoot,
	now: () => new Date(),
};

export async function initializeRepoMap(
	input: InitializeRepoMapInput,
	dependencies: Partial<RepoMapServiceDependencies> = {},
): Promise<InitializeRepoMapResult> {
	const deps = { ...defaultDependencies, ...dependencies };
	throwIfAborted(input.signal);
	const identity = await deps.detectRepository(input.cwd, signalOptions(input.signal));
	const [config, fileToolsConfig] = await Promise.all([
		deps.loadRepoMapConfig(),
		deps.loadFileToolsConfig(identity.repositoryRoot),
	]);
	throwIfAborted(input.signal);
	const ignoreSnapshot = await deps.createIgnoreSnapshot(identity.repositoryRoot, ignoreConfigFromFileTools(fileToolsConfig));
	const mapId = createRepoMapId(identity);
	const cacheRoot = deps.cacheRoot();
	const previous = input.mode === "rebuild"
		? undefined
		: await deps.readCurrent(cacheRoot, mapId, identity.repositoryRoot);
	const maxFiles = Math.min(config.scan.max_files, fileToolsConfig.limits.grep_max_files_scanned);
	const maxFileBytes = Math.min(config.scan.max_file_bytes, fileToolsConfig.limits.grep_max_file_bytes);
	const scan = await deps.scan({
		root: identity.repositoryRoot,
		fileToolsConfig,
		ignoreSnapshot,
		maxFiles,
		maxFileBytes,
		concurrency: config.scan.concurrency,
		...(previous !== undefined ? { previousFiles: previous.files } : {}),
		...(input.signal !== undefined ? { signal: input.signal } : {}),
		...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
	});
	throwIfAborted(input.signal);
	safeProgress(input.onProgress, { phase: "parsing", completed: 0, total: scan.summary.indexed });
	const symbolIndex = await deps.indexSymbols({
		root: identity.repositoryRoot,
		files: scan.files,
		concurrency: config.scan.concurrency,
		...(previous !== undefined ? {
			previous: {
				files: previous.files,
				symbols: previous.symbols,
				edges: previous.edges,
				diagnostics: previous.diagnostics,
			},
		} : {}),
		...(input.signal !== undefined ? { signal: input.signal } : {}),
	});
	throwIfAborted(input.signal);
	const architecture = await deps.buildArchitecture({
		root: identity.repositoryRoot,
		mapId,
		files: scan.files,
		symbols: symbolIndex.symbols,
		...(input.signal !== undefined ? { signal: input.signal } : {}),
	});
	throwIfAborted(input.signal);
	const relationshipEdges = await deps.buildRelationships({ mapId, files: scan.files, symbols: architecture.symbols, imports: symbolIndex.imports });
	const baseEdges = [...relationshipEdges, ...architecture.edges].sort(compareRepoMapEdge);
	const testGraph = await deps.buildTestGraph({
		root: identity.repositoryRoot,
		files: scan.files,
		symbols: architecture.symbols,
		edges: baseEdges,
		...(input.signal !== undefined ? { signal: input.signal } : {}),
	});
	const edges = [...baseEdges, ...testGraph.edges].sort(compareRepoMapEdge);
	const aliases = await deps.buildLexicalAliases({
		root: identity.repositoryRoot,
		files: scan.files,
		symbols: architecture.symbols,
		architecture: architecture.nodes,
		edges,
		concurrency: config.scan.concurrency,
		...(input.signal !== undefined ? { signal: input.signal } : {}),
	});
	throwIfAborted(input.signal);
	const diagnostics = [...scan.diagnostics, ...symbolIndex.diagnostics, ...architecture.diagnostics, ...testGraph.diagnostics];
	const summary: RepoMapScanSummary = {
		...scan.summary,
		parsed: symbolIndex.parsedFileCount,
		unsupported: symbolIndex.unsupportedFileCount,
		parseErrors: symbolIndex.parseErrorFileCount,
		reusedParsed: symbolIndex.reusedParsedFileCount,
		symbols: architecture.symbols.length,
		testNodes: testGraph.nodes.length,
		edges: edges.length,
		diagnostics: diagnostics.length,
	};
	const endingRevision = await deps.readHeadRevision(identity.worktreeRoot, signalOptions(input.signal));
	if (endingRevision !== identity.headRevision) {
		throw new RepoMapError("REPOSITORY_CHANGED_DURING_SCAN", "Repository HEAD changed during Repo Map scan; run /init again.");
	}
	const configFingerprint = combinedConfigFingerprint(config, fileToolsConfig);
	const generationId = calculateGeneration({
		mapId,
		configFingerprint,
		ignoreFingerprint: ignoreSnapshot.fingerprint,
		parserFingerprint: CODE_INDEX_FORMAT_VERSION,
		...(identity.headRevision !== undefined ? { headRevision: identity.headRevision } : {}),
		files: scan.files,
		symbols: architecture.symbols,
		tests: testGraph.nodes,
		architecture: architecture.nodes,
		aliases,
		edges,
		diagnostics,
	});
	const now = deps.now().toISOString();
	const partial = summary.unreadable > 0
		|| summary.unstable > 0
		|| summary.parseErrors > 0
		|| diagnostics.some((diagnostic) => diagnostic.code === "DIRECTORY_UNREADABLE" || diagnostic.code.startsWith("ARCHITECTURE_") || diagnostic.code.startsWith("TEST_GRAPH_"));
	const metadata: RepoMapMetadata = {
		schemaVersion: REPO_MAP_SCHEMA_VERSION,
		mapId,
		repositoryRoot: identity.repositoryRoot,
		worktreeRoot: identity.worktreeRoot,
		gitCommonDir: identity.gitCommonDir,
		generation: generationId,
		createdAt: previous?.metadata.generation === generationId ? previous.metadata.createdAt : now,
		updatedAt: now,
		freshness: partial ? "partially_stale" : "fresh",
		fileCount: scan.files.length,
		indexedFileCount: summary.indexed,
		parsedFileCount: summary.parsed,
		unsupportedFileCount: summary.unsupported,
		parseErrorFileCount: summary.parseErrors,
		symbolCount: architecture.symbols.length,
		testNodeCount: testGraph.nodes.length,
		edgeCount: edges.length,
		aliasCount: aliases.length,
		tooLargeFileCount: summary.tooLarge,
		diagnosticCount: diagnostics.length,
		...(identity.headRevision !== undefined ? { gitRevision: identity.headRevision } : {}),
		configFingerprint,
		ignoreFingerprint: ignoreSnapshot.fingerprint,
		parserFingerprint: CODE_INDEX_FORMAT_VERSION,
	};
	safeProgress(input.onProgress, { phase: "saving" });
	const committed = await deps.commit({
		cacheRoot,
		maxGenerations: config.cache.max_generations,
		metadata,
		files: scan.files,
		symbols: architecture.symbols,
		tests: testGraph.nodes,
		architecture: architecture.nodes,
		aliases,
		edges,
		diagnostics,
		...(input.signal !== undefined ? { signal: input.signal } : {}),
	});
	return {
		identity,
		metadata: committed.generation.metadata,
		summary,
		reusedGeneration: committed.reused,
	};
}

export async function readActivatedRepoMap(
	activation: { root: string; mapId: string; generation: string },
	cacheRoot = repoMapCacheRoot(),
): Promise<RepoMapGeneration | undefined> {
	return await readGeneration(cacheRoot, activation.mapId, activation.generation, activation.root);
}

/**
 * 读取 activation 指向的 generation，并检查会使整张图失效的轻量信号。
 * 文件正文 hash 仍在具体查询候选被使用前实时复核。
 */
export async function readActivatedRepoMapState(
	activation: RepoMapActivation,
	cacheRoot = repoMapCacheRoot(),
): Promise<RepoMapGeneration | undefined> {
	const [generation, current] = await Promise.all([
		readGeneration(cacheRoot, activation.mapId, activation.generation, activation.root),
		readCurrentGeneration(cacheRoot, activation.mapId, activation.root),
	]);
	if (generation === undefined || current?.metadata.generation !== activation.generation) return undefined;
	try {
		const [config, fileToolsConfig, headRevision] = await Promise.all([
			loadRepoMapConfig(),
			loadFileToolsConfigOrThrow(activation.root),
			readHeadRevision(activation.root),
		]);
		const ignoreSnapshot = await createIgnoreSnapshot(activation.root, ignoreConfigFromFileTools(fileToolsConfig));
		const freshness = evaluateRepoMapFreshness(generation.metadata, {
			configFingerprint: combinedConfigFingerprint(config, fileToolsConfig),
			ignoreFingerprint: ignoreSnapshot.fingerprint,
			parserFingerprint: CODE_INDEX_FORMAT_VERSION,
			...(headRevision !== undefined ? { gitRevision: headRevision } : {}),
		}, activation.freshness);
		return { ...generation, metadata: { ...generation.metadata, freshness } };
	} catch {
		return { ...generation, metadata: { ...generation.metadata, freshness: "stale" } };
	}
}

export interface RefreshActivatedRepoMapInput {
	activation: RepoMapActivation;
	signal?: AbortSignal;
}

/** mutation 后按 map 串行刷新，防止并发提交用较旧工作区快照覆盖较新 generation。 */
export async function refreshActivatedRepoMap(input: RefreshActivatedRepoMapInput): Promise<InitializeRepoMapResult> {
	return await withMapUpdateLock(input.activation.mapId, async () => await initializeRepoMap({
		cwd: input.activation.root,
		mode: "refresh",
		...(input.signal !== undefined ? { signal: input.signal } : {}),
	}));
}

export function combinedConfigFingerprint(repoMapConfig: RepoMapConfig, fileToolsConfig: FileToolsConfig): string {
	return createHash("sha256")
		.update(repoMapConfigFingerprint(repoMapConfig))
		.update("\0")
		.update(JSON.stringify(fileToolsConfig))
		.digest("hex");
}

export function evaluateRepoMapFreshness(
	metadata: Pick<RepoMapMetadata, "freshness" | "gitRevision" | "configFingerprint" | "ignoreFingerprint" | "parserFingerprint">,
	current: Pick<RepoMapMetadata, "configFingerprint" | "ignoreFingerprint" | "parserFingerprint"> & { gitRevision?: string },
	override?: RepoMapFreshness,
): RepoMapFreshness {
	if (
		metadata.gitRevision !== current.gitRevision
		|| metadata.configFingerprint !== current.configFingerprint
		|| metadata.ignoreFingerprint !== current.ignoreFingerprint
		|| metadata.parserFingerprint !== current.parserFingerprint
	) return "stale";
	return override ?? metadata.freshness;
}

async function loadFileToolsConfigOrThrow(root: string): Promise<FileToolsConfig> {
	const result = await loadFileToolsConfig(root);
	if (isFailed(result)) throw new RepoMapError("CONFIG_ERROR", result.error.message, result.error.details);
	return result;
}

const mapUpdateTails = new Map<string, Promise<void>>();

async function withMapUpdateLock<T>(mapId: string, operation: () => Promise<T>): Promise<T> {
	const previous = mapUpdateTails.get(mapId) ?? Promise.resolve();
	let release = (): void => undefined;
	const current = new Promise<void>((resolve) => { release = resolve; });
	const tail = previous.catch(() => undefined).then(() => current);
	mapUpdateTails.set(mapId, tail);
	await previous.catch(() => undefined);
	try {
		return await operation();
	} finally {
		release();
		if (mapUpdateTails.get(mapId) === tail) mapUpdateTails.delete(mapId);
	}
}

function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
	return signal === undefined ? {} : { signal };
}

function safeProgress(callback: InitializeRepoMapInput["onProgress"], progress: RepoMapProgress): void {
	try {
		callback?.(progress);
	} catch {
		// Rendering progress is outside the business transaction.
	}
}
