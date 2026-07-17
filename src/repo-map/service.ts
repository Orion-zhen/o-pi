import { CODE_INDEX_FORMAT_VERSION } from "../code-index/identity.js";
import { ignoreConfigFromFileTools, loadFileToolsConfig, type FileToolsConfig } from "../file-tools/config.js";
import { isFailed } from "../file-tools/core/errors.js";
import { createIgnoreSnapshot } from "../file-tools/ignore/ignore-engine.js";
import type { IgnoreSnapshot } from "../file-tools/ignore/ignore-types.js";
import { loadRepoMapConfig, repoMapCacheRoot, repoMapConfigFingerprint, type RepoMapConfig } from "./config.js";
import { RepoMapError, throwIfAborted } from "./errors.js";
import { createRepoMapId, REPO_MAP_SCHEMA_VERSION } from "./identity.js";
import type { BuildRepoMapRelationshipsInput } from "./relationship-indexer.js";
import { detectRepository, readHeadRevision, type RepositoryIdentity } from "./repository.js";
import { scanRepoMap, type RepoMapProgress, type RepoMapScanInput, type RepoMapScanResult } from "./scanner.js";
import type { IndexRepoMapSymbolsInput } from "./symbol-indexer.js";
import {
	calculateGeneration,
	commitGeneration,
	readCurrentGeneration,
	readGeneration,
	type CommitGenerationInput,
	type CommitGenerationResult,
	type RepoMapGeneration,
} from "./storage.js";
import type { RepoMapEdge, RepoMapMetadata, RepoMapScanSummary } from "./types.js";
import type { RepoMapSymbolIndex } from "./graph-types.js";

export interface InitializeRepoMapInput {
	cwd: string;
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
	buildRelationships(input: BuildRepoMapRelationshipsInput): Promise<RepoMapEdge[]>;
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
	const previous = await deps.readCurrent(cacheRoot, mapId, identity.repositoryRoot);
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
	const edges = await deps.buildRelationships({ mapId, files: scan.files, symbols: symbolIndex.symbols, imports: symbolIndex.imports });
	const diagnostics = [...scan.diagnostics, ...symbolIndex.diagnostics];
	const summary: RepoMapScanSummary = {
		...scan.summary,
		parsed: symbolIndex.parsedFileCount,
		unsupported: symbolIndex.unsupportedFileCount,
		parseErrors: symbolIndex.parseErrorFileCount,
		reusedParsed: symbolIndex.reusedParsedFileCount,
		symbols: symbolIndex.symbols.length,
		edges: edges.length,
		diagnostics: diagnostics.length,
	};
	const endingRevision = await deps.readHeadRevision(identity.worktreeRoot, signalOptions(input.signal));
	if (endingRevision !== identity.headRevision) {
		throw new RepoMapError("REPOSITORY_CHANGED_DURING_SCAN", "Repository HEAD changed during Repo Map scan; run /init again.");
	}
	const configFingerprint = repoMapConfigFingerprint(config);
	const generationId = calculateGeneration({
		mapId,
		configFingerprint,
		ignoreFingerprint: ignoreSnapshot.fingerprint,
		parserFingerprint: CODE_INDEX_FORMAT_VERSION,
		...(identity.headRevision !== undefined ? { headRevision: identity.headRevision } : {}),
		files: scan.files,
		symbols: symbolIndex.symbols,
		edges,
		diagnostics,
	});
	const now = deps.now().toISOString();
	const partial = summary.unreadable > 0
		|| summary.unstable > 0
		|| summary.parseErrors > 0
		|| diagnostics.some((diagnostic) => diagnostic.code === "DIRECTORY_UNREADABLE");
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
		symbolCount: symbolIndex.symbols.length,
		edgeCount: edges.length,
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
		symbols: symbolIndex.symbols,
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
