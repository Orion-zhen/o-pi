import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { createFileIdentity, createSymbolId } from "../code-index/identity.js";
import { RepoMapError, throwIfAborted } from "./errors.js";
import { compareRepoMapEdge } from "./graph-types.js";
import { createRepoMapId, REPO_MAP_SCHEMA_VERSION } from "./identity.js";
import type {
	RepoMapArchitectureNode,
	RepoMapDiagnostic,
	RepoMapEdge,
	RepoMapEvidence,
	RepoMapFileRecord,
	RepoMapLexicalAlias,
	RepoMapMetadata,
	RepoMapSymbolNode,
} from "./types.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

export interface RepoMapGeneration {
	metadata: RepoMapMetadata;
	files: RepoMapFileRecord[];
	symbols: RepoMapSymbolNode[];
	aliases: RepoMapLexicalAlias[];
	edges: RepoMapEdge[];
	architecture: RepoMapArchitectureNode[];
	diagnostics: RepoMapDiagnostic[];
}

export interface CommitGenerationInput extends RepoMapGeneration {
	cacheRoot: string;
	maxGenerations: number;
	signal?: AbortSignal;
}

export interface CommitGenerationResult {
	generation: RepoMapGeneration;
	reused: boolean;
}

export function calculateGeneration(input: {
	mapId: string;
	configFingerprint: string;
	ignoreFingerprint: string;
	parserFingerprint: string;
	headRevision?: string;
	files: readonly RepoMapFileRecord[];
	symbols: readonly RepoMapSymbolNode[];
	aliases: readonly RepoMapLexicalAlias[];
	edges: readonly RepoMapEdge[];
	architecture: readonly RepoMapArchitectureNode[];
	diagnostics: readonly RepoMapDiagnostic[];
}): string {
	const hash = createHash("sha256");
	const values: unknown[] = [
		input.mapId,
		REPO_MAP_SCHEMA_VERSION,
		input.configFingerprint,
		input.ignoreFingerprint,
		input.parserFingerprint,
		input.headRevision ?? null,
		[...input.files]
			.sort((left, right) => compareStable(left.path, right.path))
			.map((file) => [file.id, file.path, file.size, file.mtimeMs, file.status, file.contentHash ?? null]),
		[...input.symbols]
			.sort(compareSymbol)
			.map((symbol) => [
				symbol.id, symbol.fileId, symbol.symbolKind, symbol.name ?? null, symbol.qualifiedName ?? null, symbol.signature ?? null,
				symbol.startLine, symbol.endLine, symbol.startByte, symbol.endByte,
				[...symbol.definitions], [...symbol.references], [...symbol.calls], [...symbol.imports], symbol.visibility ?? null,
			]),
		[...input.architecture].sort(compareArchitecture).map(architectureSnapshot),
		sortedAliases(input.aliases).map((alias) => [
			alias.term, alias.canonical, alias.target, alias.source, alias.confidence,
			alias.evidence.map((evidence) => [
				evidence.path, evidence.startLine, evidence.endLine, evidence.startByte, evidence.endByte, evidence.textHash ?? null,
			]),
		]),
		sortedEdges(input.edges)
			.map((edge) => [
				edge.kind, edge.from, edge.to, edge.resolution, edge.source, edge.confidence, edge.lexicalTarget ?? null,
				edge.evidence.map((evidence) => [
					evidence.path, evidence.startLine, evidence.endLine, evidence.startByte, evidence.endByte, evidence.textHash ?? null,
				]),
			]),
		[...input.diagnostics]
			.sort(compareDiagnostic)
			.map((diagnostic) => [diagnostic.code, diagnostic.message, diagnostic.path ?? null]),
	];
	for (const value of values) {
		const encoded = JSON.stringify(value);
		hash.update(`${Buffer.byteLength(encoded)}:`).update(encoded);
	}
	return hash.digest("hex");
}

export async function readCurrentGeneration(
	cacheRoot: string,
	mapId: string,
	expectedRoot?: string,
): Promise<RepoMapGeneration | undefined> {
	if (!HASH_PATTERN.test(mapId)) return undefined;
	let current: string;
	try {
		current = (await readFile(path.join(cacheRoot, mapId, "CURRENT"), "utf8")).trim();
	} catch {
		return undefined;
	}
	if (!isGenerationId(current)) return undefined;
	return await readGeneration(cacheRoot, mapId, current, expectedRoot);
}

export async function readGeneration(
	cacheRoot: string,
	mapId: string,
	generation: string,
	expectedRoot?: string,
): Promise<RepoMapGeneration | undefined> {
	if (!HASH_PATTERN.test(mapId) || !isGenerationId(generation)) return undefined;
	const directory = generationDirectory(cacheRoot, mapId, generation);
	try {
		const directoryInfo = await lstat(directory);
		if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return undefined;
		const [metadataValue, filesValue, symbolsValue, architectureValue, aliasesValue, edgesValue, diagnosticsValue] = await Promise.all([
			readJson(path.join(directory, "metadata.json")),
			readJson(path.join(directory, "files.json")),
			readJson(path.join(directory, "symbols.json")),
			readJson(path.join(directory, "architecture.json")),
			readJson(path.join(directory, "aliases.json")),
			readJson(path.join(directory, "edges.json")),
			readJson(path.join(directory, "diagnostics.json")),
		]);
		const metadata = validateMetadata(metadataValue, mapId, generation, expectedRoot);
		const files = validateFiles(filesValue);
		const symbols = validateSymbols(symbolsValue, files);
		const architecture = validateArchitecture(architectureValue, files);
		const aliases = validateAliases(aliasesValue, metadata.mapId, files, symbols, architecture);
		const edges = validateEdges(edgesValue, metadata.mapId, files, symbols, architecture);
		const diagnostics = validateDiagnostics(diagnosticsValue);
		if (metadata.fileCount !== files.length) return undefined;
		if (metadata.indexedFileCount !== files.filter((file) => file.status === "indexed").length) return undefined;
		if (metadata.tooLargeFileCount !== files.filter((file) => file.status === "too_large").length) return undefined;
		if (metadata.symbolCount !== symbols.length || metadata.edgeCount !== edges.length || metadata.aliasCount !== aliases.length) return undefined;
		if (metadata.diagnosticCount !== diagnostics.length) return undefined;
		if (calculateGeneration({
			mapId,
			configFingerprint: metadata.configFingerprint,
			ignoreFingerprint: metadata.ignoreFingerprint,
			parserFingerprint: metadata.parserFingerprint,
			...(metadata.gitRevision !== undefined ? { headRevision: metadata.gitRevision } : {}),
			files,
			symbols,
			architecture,
			aliases,
			edges,
			diagnostics,
		}) !== generation) return undefined;
		return { metadata, files, symbols, architecture, aliases, edges, diagnostics };
	} catch {
		return undefined;
	}
}

export async function commitGeneration(input: CommitGenerationInput): Promise<CommitGenerationResult> {
	throwIfAborted(input.signal);
	validateCommitInput(input);
	const mapDirectory = path.join(input.cacheRoot, input.metadata.mapId);
	const generationsDirectory = path.join(mapDirectory, "generations");
	await prepareCacheDirectories(input.cacheRoot, mapDirectory, generationsDirectory);
	const releaseLock = await acquireCommitLock(mapDirectory);
	let temporaryDirectory: string | undefined;
	try {
		const existing = await readGeneration(input.cacheRoot, input.metadata.mapId, input.metadata.generation, input.metadata.repositoryRoot);
		let generation = existing;
		let reused = existing !== undefined;
		if (generation === undefined) {
			temporaryDirectory = await mkdtemp(path.join(generationsDirectory, ".tmp-"));
			await bestEffortChmod(temporaryDirectory, 0o700);
			await writeJsonFile(path.join(temporaryDirectory, "metadata.json"), input.metadata);
			await writeJsonFile(path.join(temporaryDirectory, "files.json"), [...input.files].sort((a, b) => compareStable(a.path, b.path)));
			await writeJsonFile(path.join(temporaryDirectory, "symbols.json"), [...input.symbols].sort(compareSymbol));
			await writeJsonFile(path.join(temporaryDirectory, "architecture.json"), [...input.architecture].sort(compareArchitecture));
			await writeJsonFile(path.join(temporaryDirectory, "aliases.json"), sortedAliases(input.aliases));
			await writeJsonFile(path.join(temporaryDirectory, "edges.json"), sortedEdges(input.edges));
			await writeJsonFile(path.join(temporaryDirectory, "diagnostics.json"), [...input.diagnostics].sort(compareDiagnostic));
			throwIfAborted(input.signal);
			const destination = generationDirectory(input.cacheRoot, input.metadata.mapId, input.metadata.generation);
			if (await exists(destination)) {
				const racedGeneration = await readGeneration(
					input.cacheRoot,
					input.metadata.mapId,
					input.metadata.generation,
					input.metadata.repositoryRoot,
				);
				if (racedGeneration !== undefined) {
					generation = racedGeneration;
					reused = true;
				} else {
					const corruptName = path.join(generationsDirectory, `.corrupt-${input.metadata.generation}-${randomUUID()}`);
					await rename(destination, corruptName);
				}
			}
			if (generation === undefined) {
				await rename(temporaryDirectory, destination);
				temporaryDirectory = undefined;
				generation = await readGeneration(input.cacheRoot, input.metadata.mapId, input.metadata.generation, input.metadata.repositoryRoot);
				if (generation === undefined) throw new RepoMapError("CACHE_ERROR", "Repo Map generation failed validation after saving.");
			}
		}
		throwIfAborted(input.signal);
		await replaceCurrent(mapDirectory, input.metadata.generation);
		await cleanupGenerations(input.cacheRoot, input.metadata.mapId, input.metadata.generation, input.maxGenerations);
		return { generation, reused };
	} catch (error) {
		if (error instanceof RepoMapError) throw error;
		throw new RepoMapError("CACHE_ERROR", "Repo Map cache could not be saved.", error);
	} finally {
		if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
		await releaseLock();
	}
}

function validateCommitInput(input: CommitGenerationInput): void {
	const metadata = validateMetadata(input.metadata, input.metadata.mapId, input.metadata.generation, input.metadata.repositoryRoot);
	const files = validateFiles(input.files);
	const symbols = validateSymbols(input.symbols, files);
	const architecture = validateArchitecture(input.architecture, files);
	const aliases = validateAliases(input.aliases, metadata.mapId, files, symbols, architecture);
	const edges = validateEdges(input.edges, metadata.mapId, files, symbols, architecture);
	const diagnostics = validateDiagnostics(input.diagnostics);
	if (
		metadata.fileCount !== files.length
		|| metadata.symbolCount !== symbols.length
		|| metadata.edgeCount !== edges.length
		|| metadata.aliasCount !== aliases.length
		|| metadata.diagnosticCount !== diagnostics.length
	) {
		throw new RepoMapError("CACHE_ERROR", "Repo Map generation counts are inconsistent.");
	}
}

async function replaceCurrent(mapDirectory: string, generation: string): Promise<void> {
	const temporaryPath = path.join(mapDirectory, `.CURRENT-${process.pid}-${randomUUID()}.tmp`);
	try {
		await writeTextFile(temporaryPath, `${generation}\n`);
		await rename(temporaryPath, path.join(mapDirectory, "CURRENT"));
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

async function cleanupGenerations(cacheRoot: string, mapId: string, current: string, maxGenerations: number): Promise<void> {
	try {
		const directory = path.join(cacheRoot, mapId, "generations");
		const entries = await readdir(directory, { withFileTypes: true });
		const candidates: Array<{ id: string; mtimeMs: number }> = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || !isGenerationId(entry.name) || entry.name === current) continue;
			const info = await stat(path.join(directory, entry.name));
			candidates.push({ id: entry.name, mtimeMs: info.mtimeMs });
		}
		candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || compareStable(a.id, b.id));
		const keepOther = Math.max(0, maxGenerations - 1);
		for (const candidate of candidates.slice(keepOther)) {
			await rm(generationDirectory(cacheRoot, mapId, candidate.id), { recursive: true, force: true });
		}
	} catch {
		// Cleanup cannot invalidate the generation just committed.
	}
}

function validateMetadata(value: unknown, mapId: string, generation: string, expectedRoot?: string): RepoMapMetadata {
	if (!isRecord(value)) throw new Error("invalid metadata");
	if (
		value["schemaVersion"] !== REPO_MAP_SCHEMA_VERSION
		|| value["mapId"] !== mapId
		|| value["generation"] !== generation
		|| !isNonEmptyString(value["repositoryRoot"])
		|| !isNonEmptyString(value["worktreeRoot"])
		|| !isNonEmptyString(value["gitCommonDir"])
		|| (expectedRoot !== undefined && path.resolve(value["repositoryRoot"]) !== path.resolve(expectedRoot))
		|| (expectedRoot !== undefined && path.resolve(value["worktreeRoot"]) !== path.resolve(expectedRoot))
		|| !isCanonicalAbsolutePath(value["repositoryRoot"])
		|| !isCanonicalAbsolutePath(value["worktreeRoot"])
		|| !isCanonicalAbsolutePath(value["gitCommonDir"])
		|| createRepoMapId({ worktreeRoot: value["worktreeRoot"], gitCommonDir: value["gitCommonDir"] }) !== mapId
		|| !isIsoDate(value["createdAt"])
		|| !isIsoDate(value["updatedAt"])
		|| !isFreshness(value["freshness"])
		|| !isCount(value["fileCount"])
		|| !isCount(value["indexedFileCount"])
		|| !isCount(value["parsedFileCount"])
		|| !isCount(value["unsupportedFileCount"])
		|| !isCount(value["parseErrorFileCount"])
		|| !isCount(value["symbolCount"])
		|| !isCount(value["edgeCount"])
		|| !isCount(value["aliasCount"])
		|| !isCount(value["tooLargeFileCount"])
		|| !isCount(value["diagnosticCount"])
		|| (value["gitRevision"] !== undefined && !isGitRevision(value["gitRevision"]))
		|| !isHash(value["configFingerprint"])
		|| !isNonEmptyString(value["ignoreFingerprint"])
		|| !isNonEmptyString(value["parserFingerprint"])
	) throw new Error("invalid metadata");
	if (value["parsedFileCount"] + value["unsupportedFileCount"] + value["parseErrorFileCount"] !== value["indexedFileCount"]) {
		throw new Error("invalid index counts");
	}
	return {
		schemaVersion: REPO_MAP_SCHEMA_VERSION,
		mapId,
		repositoryRoot: value["repositoryRoot"],
		worktreeRoot: value["worktreeRoot"],
		gitCommonDir: value["gitCommonDir"],
		generation,
		createdAt: value["createdAt"],
		updatedAt: value["updatedAt"],
		freshness: value["freshness"],
		fileCount: value["fileCount"],
		indexedFileCount: value["indexedFileCount"],
		parsedFileCount: value["parsedFileCount"],
		unsupportedFileCount: value["unsupportedFileCount"],
		parseErrorFileCount: value["parseErrorFileCount"],
		symbolCount: value["symbolCount"],
		edgeCount: value["edgeCount"],
		aliasCount: value["aliasCount"],
		tooLargeFileCount: value["tooLargeFileCount"],
		diagnosticCount: value["diagnosticCount"],
		...(typeof value["gitRevision"] === "string" ? { gitRevision: value["gitRevision"] } : {}),
		configFingerprint: value["configFingerprint"],
		ignoreFingerprint: value["ignoreFingerprint"],
		parserFingerprint: value["parserFingerprint"],
	};
}

function validateFiles(value: unknown): RepoMapFileRecord[] {
	if (!Array.isArray(value)) throw new Error("invalid files");
	const files: RepoMapFileRecord[] = [];
	let previousPath: string | undefined;
	for (const item of value) {
		if (!isRecord(item) || !isSafeRelativePath(item["path"]) || !isNonNegativeFinite(item["size"]) || !isNonNegativeFinite(item["mtimeMs"]) || !isFileStatus(item["status"])) {
			throw new Error("invalid file record");
		}
		const identity = createFileIdentity(item["path"]);
		if (item["id"] !== identity.id || (previousPath !== undefined && compareStable(previousPath, item["path"]) >= 0)) throw new Error("invalid file identity or order");
		if (item["status"] === "indexed" ? !isHash(item["contentHash"]) : item["contentHash"] !== undefined) throw new Error("invalid content hash");
		files.push({
			...identity,
			size: item["size"],
			mtimeMs: item["mtimeMs"],
			status: item["status"],
			...(typeof item["contentHash"] === "string" ? { contentHash: item["contentHash"] } : {}),
		});
		previousPath = item["path"];
	}
	return files;
}

function validateSymbols(value: unknown, files: readonly RepoMapFileRecord[]): RepoMapSymbolNode[] {
	if (!Array.isArray(value)) throw new Error("invalid symbols");
	const fileIds = new Set(files.map((file) => file.id));
	const symbols: RepoMapSymbolNode[] = [];
	let previous: RepoMapSymbolNode | undefined;
	for (const item of value) {
		if (
			!isRecord(item)
			|| item["kind"] !== "symbol"
			|| !isNonEmptyString(item["id"])
			|| !isNonEmptyString(item["fileId"])
			|| !fileIds.has(item["fileId"])
			|| !isNonEmptyString(item["symbolKind"])
			|| (item["name"] !== undefined && !isNonEmptyString(item["name"]))
			|| (item["qualifiedName"] !== undefined && !isNonEmptyString(item["qualifiedName"]))
			|| (item["signature"] !== undefined && typeof item["signature"] !== "string")
			|| (item["visibility"] !== undefined && item["visibility"] !== "public" && item["visibility"] !== "internal")
			|| !isSourceRange(item)
			|| !isStringArray(item["definitions"])
			|| !isStringArray(item["references"])
			|| !isStringArray(item["calls"])
			|| !isStringArray(item["imports"])
		) throw new Error("invalid symbol");
		const symbol: RepoMapSymbolNode = {
			kind: "symbol",
			id: item["id"],
			fileId: item["fileId"],
			symbolKind: item["symbolKind"],
			...(typeof item["name"] === "string" ? { name: item["name"] } : {}),
			...(typeof item["qualifiedName"] === "string" ? { qualifiedName: item["qualifiedName"] } : {}),
			...(typeof item["signature"] === "string" ? { signature: item["signature"] } : {}),
			startLine: item["startLine"],
			endLine: item["endLine"],
			startByte: item["startByte"],
			endByte: item["endByte"],
			definitions: item["definitions"],
			references: item["references"],
			calls: item["calls"],
			imports: item["imports"],
			...(item["visibility"] === "public" || item["visibility"] === "internal" ? { visibility: item["visibility"] } : {}),
		};
		if (symbol.id !== createSymbolId({
			fileId: symbol.fileId,
			kind: symbol.symbolKind,
			...(symbol.name !== undefined ? { name: symbol.name } : {}),
			...(symbol.qualifiedName !== undefined ? { qualifiedName: symbol.qualifiedName } : {}),
			startByte: symbol.startByte,
		})) throw new Error("invalid symbol identity");
		if (previous !== undefined && compareSymbol(previous, symbol) >= 0) throw new Error("invalid symbol order");
		symbols.push(symbol);
		previous = symbol;
	}
	return symbols;
}

function validateArchitecture(value: unknown, files: readonly RepoMapFileRecord[]): RepoMapArchitectureNode[] {
	if (!Array.isArray(value)) throw new Error("invalid architecture");
	const fileIds = new Set(files.map((file) => file.id));
	const nodes: RepoMapArchitectureNode[] = [];
	const ids = new Set<string>();
	for (const item of value) {
		if (!isRecord(item) || !isArchitectureKind(item["kind"]) || !isNonEmptyString(item["id"]) || ids.has(item["id"])
			|| !isNonEmptyString(item["name"]) || !isConfidence(item["confidence"]) || !isArchitectureSource(item["source"])) throw new Error("invalid architecture node");
		let node: RepoMapArchitectureNode;
		if (item["kind"] === "package") {
			if (!isRepoRootPath(item["rootPath"]) || !isPackageEcosystem(item["ecosystem"])
				|| (item["manifestPath"] !== undefined && !isSafeRelativePath(item["manifestPath"]))) throw new Error("invalid package node");
			node = { kind: "package", id: item["id"], name: item["name"], rootPath: item["rootPath"], ecosystem: item["ecosystem"], ...(typeof item["manifestPath"] === "string" ? { manifestPath: item["manifestPath"] } : {}), source: item["source"], confidence: item["confidence"] };
		} else if (item["kind"] === "component") {
			if (!isRepoRootPath(item["rootPath"]) || !isNonEmptyString(item["packageId"])) throw new Error("invalid component node");
			node = { kind: "component", id: item["id"], name: item["name"], rootPath: item["rootPath"], packageId: item["packageId"], source: item["source"], confidence: item["confidence"] };
		} else {
			if (!isEntrypointType(item["entrypointType"]) || (item["packageId"] !== undefined && !isNonEmptyString(item["packageId"]))
				|| (item["fileId"] !== undefined && (!isNonEmptyString(item["fileId"]) || !fileIds.has(item["fileId"])))
				|| (item["declaredTarget"] !== undefined && !isNonEmptyString(item["declaredTarget"]))) throw new Error("invalid entrypoint node");
			node = { kind: "entrypoint", id: item["id"], name: item["name"], entrypointType: item["entrypointType"], ...(typeof item["packageId"] === "string" ? { packageId: item["packageId"] } : {}), ...(typeof item["fileId"] === "string" ? { fileId: item["fileId"] } : {}), ...(typeof item["declaredTarget"] === "string" ? { declaredTarget: item["declaredTarget"] } : {}), source: item["source"], confidence: item["confidence"] };
		}
		ids.add(node.id);
		nodes.push(node);
	}
	if (nodes.some((node) => node.kind === "component" && !ids.has(node.packageId))
		|| nodes.some((node) => node.kind === "entrypoint" && node.packageId !== undefined && !ids.has(node.packageId))) throw new Error("dangling architecture owner");
	const sorted = [...nodes].sort(compareArchitecture);
	if (nodes.some((node, index) => node.id !== sorted[index]?.id)) throw new Error("invalid architecture order");
	return nodes;
}

function validateAliases(
	value: unknown,
	mapId: string,
	files: readonly RepoMapFileRecord[],
	symbols: readonly RepoMapSymbolNode[],
	architecture: readonly RepoMapArchitectureNode[],
): RepoMapLexicalAlias[] {
	if (!Array.isArray(value)) throw new Error("invalid aliases");
	const targets = new Set([`repository:${mapId}`, ...files.map((file) => file.id), ...symbols.map((symbol) => symbol.id), ...architecture.map((node) => node.id)]);
	const aliases: RepoMapLexicalAlias[] = [];
	let previous: RepoMapLexicalAlias | undefined;
	for (const item of value) {
		if (!isRecord(item)
			|| !isLexicalTerm(item["term"])
			|| !isLexicalTerm(item["canonical"])
			|| !isNonEmptyString(item["target"])
			|| !targets.has(item["target"])
			|| !isAliasSource(item["source"])
			|| !isConfidence(item["confidence"])
			|| !Array.isArray(item["evidence"])
			|| item["evidence"].length === 0) throw new Error("invalid alias");
		const alias: RepoMapLexicalAlias = {
			term: item["term"],
			canonical: item["canonical"],
			target: item["target"],
			source: item["source"],
			confidence: item["confidence"],
			evidence: item["evidence"].map(validateAliasEvidence),
		};
		if (previous !== undefined && compareAlias(previous, alias) >= 0) throw new Error("invalid alias order");
		aliases.push(alias);
		previous = alias;
	}
	return aliases;
}

function validateAliasEvidence(value: unknown): RepoMapEvidence {
	if (!isRecord(value) || !isSafeDiagnosticPath(value["path"]) || !isSourceRange(value) || (value["textHash"] !== undefined && !isHash(value["textHash"]))) {
		throw new Error("invalid alias evidence");
	}
	return {
		path: value["path"],
		...(typeof value["textHash"] === "string" ? { textHash: value["textHash"] } : {}),
		startLine: value["startLine"],
		endLine: value["endLine"],
		startByte: value["startByte"],
		endByte: value["endByte"],
	};
}

function validateEdges(
	value: unknown,
	mapId: string,
	files: readonly RepoMapFileRecord[],
	symbols: readonly RepoMapSymbolNode[],
	architecture: readonly RepoMapArchitectureNode[],
): RepoMapEdge[] {
	if (!Array.isArray(value)) throw new Error("invalid edges");
	const nodes = new Set([`repository:${mapId}`, ...files.map((file) => file.id), ...symbols.map((symbol) => symbol.id), ...architecture.map((node) => node.id)]);
	const edges: RepoMapEdge[] = [];
	let previous: RepoMapEdge | undefined;
	for (const item of value) {
		if (
			!isRecord(item)
			|| !isEdgeKind(item["kind"])
			|| !isNonEmptyString(item["from"])
			|| !nodes.has(item["from"])
			|| !isNonEmptyString(item["to"])
			|| (!nodes.has(item["to"]) && !item["to"].startsWith("external:") && !item["to"].startsWith("lexical:symbol:"))
			|| !isEdgeResolution(item["resolution"])
			|| !isEdgeSource(item["source"])
			|| typeof item["confidence"] !== "number"
			|| !Number.isFinite(item["confidence"])
			|| item["confidence"] < 0
			|| item["confidence"] > 1
			|| (item["lexicalTarget"] !== undefined && !isNonEmptyString(item["lexicalTarget"]))
			|| !Array.isArray(item["evidence"])
			|| item["evidence"].length === 0
		) throw new Error("invalid edge");
		const edge: RepoMapEdge = {
			kind: item["kind"],
			from: item["from"],
			to: item["to"],
			resolution: item["resolution"],
			source: item["source"],
			confidence: item["confidence"],
			...(typeof item["lexicalTarget"] === "string" ? { lexicalTarget: item["lexicalTarget"] } : {}),
			evidence: item["evidence"].map(validateEvidence),
		};
		if (previous !== undefined && compareRepoMapEdge(previous, edge) >= 0) throw new Error("invalid edge order");
		edges.push(edge);
		previous = edge;
	}
	return edges;
}

function validateEvidence(value: unknown): RepoMapEvidence {
	if (!isRecord(value) || !isSafeRelativePath(value["path"]) || !isSourceRange(value) || (value["textHash"] !== undefined && !isHash(value["textHash"]))) {
		throw new Error("invalid edge evidence");
	}
	return {
		path: value["path"],
		...(typeof value["textHash"] === "string" ? { textHash: value["textHash"] } : {}),
		startLine: value["startLine"],
		endLine: value["endLine"],
		startByte: value["startByte"],
		endByte: value["endByte"],
	};
}

function validateDiagnostics(value: unknown): RepoMapDiagnostic[] {
	if (!Array.isArray(value)) throw new Error("invalid diagnostics");
	return value.map((item) => {
		if (!isRecord(item) || !isNonEmptyString(item["code"]) || !isNonEmptyString(item["message"])) throw new Error("invalid diagnostic");
		if (item["path"] !== undefined && !isSafeDiagnosticPath(item["path"])) throw new Error("invalid diagnostic path");
		return {
			code: item["code"],
			message: item["message"],
			...(typeof item["path"] === "string" ? { path: item["path"] } : {}),
		};
	});
}

async function readJson(filePath: string): Promise<unknown> {
	return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextFile(filePath: string, value: string): Promise<void> {
	const handle = await open(filePath, "wx", 0o600);
	try {
		await handle.writeFile(value, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function bestEffortChmod(target: string, mode: number): Promise<void> {
	await chmod(target, mode).catch(() => undefined);
}

async function prepareCacheDirectories(cacheRoot: string, mapDirectory: string, generationsDirectory: string): Promise<void> {
	try {
		await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
		await ensurePrivateDirectory(mapDirectory);
		await ensurePrivateDirectory(generationsDirectory);
		await bestEffortChmod(cacheRoot, 0o700);
	} catch (error) {
		throw new RepoMapError("CACHE_ERROR", "Repo Map cache directory is not safe or cannot be created.", error);
	}
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	try {
		await mkdir(directory, { mode: 0o700 });
	} catch (error) {
		if (!isErrorCode(error, "EEXIST")) throw error;
	}
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("cache path is not a real directory");
	await bestEffortChmod(directory, 0o700);
}

async function acquireCommitLock(mapDirectory: string): Promise<() => Promise<void>> {
	const lockPath = path.join(mapDirectory, "COMMIT_LOCK");
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(lockPath, "wx", 0o600);
	} catch (error) {
		if (!isErrorCode(error, "EEXIST") || !await removeStaleLock(lockPath)) {
			throw new RepoMapError("CACHE_ERROR", "Another Repo Map commit is already in progress.", error);
		}
		try {
			handle = await open(lockPath, "wx", 0o600);
		} catch (retryError) {
			throw new RepoMapError("CACHE_ERROR", "Another Repo Map commit is already in progress.", retryError);
		}
	}
	try {
		await handle.writeFile(`${process.pid}\n`, "utf8");
		await handle.sync();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(lockPath, { force: true }).catch(() => undefined);
		throw new RepoMapError("CACHE_ERROR", "Repo Map commit lock could not be created.", error);
	}
	return async () => {
		await handle.close().catch(() => undefined);
		await rm(lockPath, { force: true }).catch(() => undefined);
	};
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
	try {
		const info = await lstat(lockPath);
		if (!info.isFile() || Date.now() - info.mtimeMs < 10 * 60 * 1000) return false;
		await rm(lockPath, { force: true });
		return true;
	} catch {
		return false;
	}
}

async function exists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

function generationDirectory(cacheRoot: string, mapId: string, generation: string): string {
	return path.join(cacheRoot, mapId, "generations", generation);
}

function isGenerationId(value: string): boolean {
	return HASH_PATTERN.test(value) && !value.includes("..") && !path.isAbsolute(value) && !value.includes("/") && !value.includes("\\");
}

function isSafeRelativePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) return false;
	const normalized = path.posix.normalize(value);
	return normalized === value && value !== "." && value !== ".." && !value.startsWith("../");
}

function isSafeDiagnosticPath(value: unknown): value is string {
	return value === "." || isSafeRelativePath(value) || (typeof value === "string" && value.startsWith("<") && value.endsWith(">"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isIsoDate(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isCanonicalAbsolutePath(value: string): boolean {
	return path.isAbsolute(value) && !value.includes("\0") && path.normalize(value) === value;
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isHash(value: unknown): value is string {
	return typeof value === "string" && HASH_PATTERN.test(value);
}

function isGitRevision(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{40,64}$/u.test(value);
}

function isFreshness(value: unknown): value is RepoMapMetadata["freshness"] {
	return value === "fresh" || value === "partially_stale" || value === "stale" || value === "unavailable";
}

function isFileStatus(value: unknown): value is RepoMapFileRecord["status"] {
	return value === "indexed" || value === "too_large" || value === "unreadable" || value === "unstable";
}

function isArchitectureKind(value: unknown): value is RepoMapArchitectureNode["kind"] {
	return value === "package" || value === "component" || value === "entrypoint";
}

function isArchitectureSource(value: unknown): value is RepoMapArchitectureNode["source"] {
	return value === "manifest" || value === "convention" || value === "syntactic";
}

function isPackageEcosystem(value: unknown): value is Extract<RepoMapArchitectureNode, { kind: "package" }>["ecosystem"] {
	return value === "npm" || value === "python" || value === "go" || value === "cargo" || value === "repository";
}

function isEntrypointType(value: unknown): value is Extract<RepoMapArchitectureNode, { kind: "entrypoint" }>["entrypointType"] {
	return value === "main" || value === "module" || value === "bin" || value === "export" || value === "script" || value === "test"
		|| value === "command" || value === "tool" || value === "plugin";
}

function isConfidence(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRepoRootPath(value: unknown): value is string {
	return value === "." || isSafeRelativePath(value);
}

function isSourceRange(value: Record<string, unknown>): value is Record<string, unknown> & {
	startLine: number;
	endLine: number;
	startByte: number;
	endByte: number;
} {
	return isCount(value["startLine"])
		&& value["startLine"] > 0
		&& isCount(value["endLine"])
		&& value["endLine"] >= value["startLine"]
		&& isCount(value["startByte"])
		&& isCount(value["endByte"])
		&& value["endByte"] >= value["startByte"];
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isEdgeKind(value: unknown): value is RepoMapEdge["kind"] {
	return value === "contains" || value === "belongs-to" || value === "imports" || value === "exports" || value === "references" || value === "calls"
		|| value === "declares-entrypoint" || value === "declares-script" || value === "registers-command" || value === "registers-tool"
		|| value === "registers-plugin" || value === "exports-publicly" || value === "re-exports";
}

function isEdgeResolution(value: unknown): value is RepoMapEdge["resolution"] {
	return value === "lexical" || value === "syntactic" || value === "semantic";
}

function isEdgeSource(value: unknown): value is RepoMapEdge["source"] {
	return value === "tree-sitter" || value === "syntax" || value === "manifest" || value === "lsp" || value === "convention";
}

function isAliasSource(value: unknown): value is RepoMapLexicalAlias["source"] {
	return value === "file-path" || value === "symbol" || value === "signature" || value === "import-alias" || value === "export-alias"
		|| value === "architecture" || value === "registration" || value === "config-key" || value === "environment" || value === "doc-comment";
}

function isLexicalTerm(value: unknown): value is string {
	return typeof value === "string" && value.length >= 3 && value.length <= 256 && value === value.toLocaleLowerCase() && !value.includes("\0");
}

function compareSymbol(left: RepoMapSymbolNode, right: RepoMapSymbolNode): number {
	return compareStable(left.fileId, right.fileId) || left.startByte - right.startByte || compareStable(left.id, right.id);
}

function compareArchitecture(left: RepoMapArchitectureNode, right: RepoMapArchitectureNode): number {
	return compareStable(left.kind, right.kind) || compareStable(left.id, right.id);
}

function architectureSnapshot(node: RepoMapArchitectureNode): unknown[] {
	if (node.kind === "package") return [node.kind, node.id, node.name, node.rootPath, node.ecosystem, node.manifestPath ?? null, node.source, node.confidence];
	if (node.kind === "component") return [node.kind, node.id, node.name, node.rootPath, node.packageId, node.source, node.confidence];
	return [node.kind, node.id, node.name, node.entrypointType, node.packageId ?? null, node.fileId ?? null, node.declaredTarget ?? null, node.source, node.confidence];
}

function compareDiagnostic(left: RepoMapDiagnostic, right: RepoMapDiagnostic): number {
	return compareStable(left.path ?? "", right.path ?? "") || compareStable(left.code, right.code) || compareStable(left.message, right.message);
}

function sortedEdges(edges: readonly RepoMapEdge[]): RepoMapEdge[] {
	return [...edges]
		.sort(compareRepoMapEdge)
		.map((edge) => ({ ...edge, evidence: [...edge.evidence].sort(compareEvidence) }));
}

function sortedAliases(aliases: readonly RepoMapLexicalAlias[]): RepoMapLexicalAlias[] {
	return [...aliases]
		.sort(compareAlias)
		.map((alias) => ({ ...alias, evidence: [...alias.evidence].sort(compareEvidence) }));
}

function compareAlias(left: RepoMapLexicalAlias, right: RepoMapLexicalAlias): number {
	return compareStable(left.term, right.term)
		|| compareStable(left.canonical, right.canonical)
		|| compareStable(left.target, right.target)
		|| compareStable(left.source, right.source);
}

function compareEvidence(left: RepoMapEvidence, right: RepoMapEvidence): number {
	return compareStable(left.path, right.path)
		|| left.startByte - right.startByte
		|| left.endByte - right.endByte
		|| compareStable(left.textHash ?? "", right.textHash ?? "");
}

function compareStable(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
