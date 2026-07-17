import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";

import { createFileIdentity, createSymbolId } from "../code-index/identity.js";
import { RepoMapError, throwIfAborted } from "./errors.js";
import { compareRepoMapEdge, compareRepoMapEvidence, compareText } from "./graph.js";
import { createRepoMapId, REPO_MAP_SCHEMA_VERSION } from "./identity.js";
import { storageValidators } from "./storage-schema.js";
import type {
	RepoMapArchitectureNode,
	RepoMapDiagnostic,
	RepoMapEdge,
	RepoMapEvidence,
	RepoMapFileRecord,
	RepoMapLexicalAlias,
	RepoMapMetadata,
	RepoMapSymbolNode,
	RepoMapTestNode,
} from "./types.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

export interface RepoMapGeneration {
	metadata: RepoMapMetadata;
	files: RepoMapFileRecord[];
	symbols: RepoMapSymbolNode[];
	tests: RepoMapTestNode[];
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
	tests: readonly RepoMapTestNode[];
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
			.sort((left, right) => compareText(left.path, right.path))
			.map((file) => [file.id, file.path, file.size, file.mtimeMs, file.status, file.contentHash ?? null]),
		[...input.symbols]
			.sort(compareSymbol)
			.map((symbol) => [
				symbol.id, symbol.fileId, symbol.symbolKind, symbol.name ?? null, symbol.qualifiedName ?? null, symbol.signature ?? null,
				symbol.startLine, symbol.endLine, symbol.startByte, symbol.endByte,
				[...symbol.definitions], [...symbol.references], [...symbol.calls], [...symbol.imports], symbol.visibility ?? null,
			]),
		sortedTests(input.tests).map((node) => [
			node.id, node.testKind, node.name, node.fileId, node.symbolId ?? null, node.source, node.confidence,
			node.evidence.map((evidence) => [
				evidence.path, evidence.startLine, evidence.endLine, evidence.startByte, evidence.endByte, evidence.textHash ?? null,
			]),
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
		const [metadataValue, filesValue, symbolsValue, testsValue, architectureValue, aliasesValue, edgesValue, diagnosticsValue] = await Promise.all([
			readJson(path.join(directory, "metadata.json")),
			readJson(path.join(directory, "files.json")),
			readJson(path.join(directory, "symbols.json")),
			readJson(path.join(directory, "tests.json")),
			readJson(path.join(directory, "architecture.json")),
			readJson(path.join(directory, "aliases.json")),
			readJson(path.join(directory, "edges.json")),
			readJson(path.join(directory, "diagnostics.json")),
		]);
		const metadata = validateMetadata(metadataValue, mapId, generation, expectedRoot);
		const files = validateFiles(filesValue);
		const symbols = validateSymbols(symbolsValue, files);
		const tests = validateTests(testsValue, files, symbols);
		const architecture = validateArchitecture(architectureValue, files);
		const aliases = validateAliases(aliasesValue, metadata.mapId, files, symbols, architecture, tests);
		const edges = validateEdges(edgesValue, metadata.mapId, files, symbols, architecture, tests);
		const diagnostics = validateDiagnostics(diagnosticsValue);
		if (metadata.fileCount !== files.length) return undefined;
		if (metadata.indexedFileCount !== files.filter((file) => file.status === "indexed").length) return undefined;
		if (metadata.tooLargeFileCount !== files.filter((file) => file.status === "too_large").length) return undefined;
		if (metadata.symbolCount !== symbols.length || metadata.testNodeCount !== tests.length || metadata.edgeCount !== edges.length || metadata.aliasCount !== aliases.length) return undefined;
		if (metadata.diagnosticCount !== diagnostics.length) return undefined;
		if (calculateGeneration({
			mapId,
			configFingerprint: metadata.configFingerprint,
			ignoreFingerprint: metadata.ignoreFingerprint,
			parserFingerprint: metadata.parserFingerprint,
			...(metadata.gitRevision !== undefined ? { headRevision: metadata.gitRevision } : {}),
			files,
			symbols,
			tests,
			architecture,
			aliases,
			edges,
			diagnostics,
		}) !== generation) return undefined;
		return { metadata, files, symbols, tests, architecture, aliases, edges, diagnostics };
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
			await writeJsonFile(path.join(temporaryDirectory, "files.json"), [...input.files].sort((a, b) => compareText(a.path, b.path)));
			await writeJsonFile(path.join(temporaryDirectory, "symbols.json"), [...input.symbols].sort(compareSymbol));
			await writeJsonFile(path.join(temporaryDirectory, "tests.json"), sortedTests(input.tests));
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
		await releaseLock().catch(() => undefined);
	}
}

function validateCommitInput(input: CommitGenerationInput): void {
	const metadata = validateMetadata(input.metadata, input.metadata.mapId, input.metadata.generation, input.metadata.repositoryRoot);
	const files = validateFiles(input.files);
	const symbols = validateSymbols(input.symbols, files);
	const tests = validateTests(input.tests, files, symbols);
	const architecture = validateArchitecture(input.architecture, files);
	const aliases = validateAliases(input.aliases, metadata.mapId, files, symbols, architecture, tests);
	const edges = validateEdges(input.edges, metadata.mapId, files, symbols, architecture, tests);
	const diagnostics = validateDiagnostics(input.diagnostics);
	if (
		metadata.fileCount !== files.length
		|| metadata.symbolCount !== symbols.length
		|| metadata.testNodeCount !== tests.length
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
		candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || compareText(a.id, b.id));
		const keepOther = Math.max(0, maxGenerations - 1);
		for (const candidate of candidates.slice(keepOther)) {
			await rm(generationDirectory(cacheRoot, mapId, candidate.id), { recursive: true, force: true });
		}
	} catch {
		// Cleanup cannot invalidate the generation just committed.
	}
}

function validateMetadata(value: unknown, mapId: string, generation: string, expectedRoot?: string): RepoMapMetadata {
	assertShape(storageValidators.metadata, value, "metadata");
	if (value.mapId !== mapId || value.generation !== generation
		|| (expectedRoot !== undefined && path.resolve(value.repositoryRoot) !== path.resolve(expectedRoot))
		|| (expectedRoot !== undefined && path.resolve(value.worktreeRoot) !== path.resolve(expectedRoot))
		|| !isCanonicalAbsolutePath(value.repositoryRoot)
		|| !isCanonicalAbsolutePath(value.worktreeRoot)
		|| !isCanonicalAbsolutePath(value.gitCommonDir)
		|| createRepoMapId({ worktreeRoot: value.worktreeRoot, gitCommonDir: value.gitCommonDir }) !== mapId
		|| !isIsoDate(value.createdAt)
		|| !isIsoDate(value.updatedAt)
		|| !countsAreSafe(value)) throw new Error("invalid metadata semantics");
	if (value.parsedFileCount + value.unsupportedFileCount + value.parseErrorFileCount !== value.indexedFileCount) {
		throw new Error("invalid index counts");
	}
	return value;
}

function validateFiles(value: unknown): RepoMapFileRecord[] {
	assertShape(storageValidators.files, value, "files");
	for (const file of value) {
		if (!isSafeRelativePath(file.path) || !Number.isFinite(file.size) || !Number.isFinite(file.mtimeMs)
			|| file.id !== createFileIdentity(file.path).id
			|| (file.status === "indexed") !== (file.contentHash !== undefined)) throw new Error("invalid file semantics");
	}
	assertStrictOrder(value, (left, right) => compareText(left.path, right.path), "files");
	return value;
}

function validateSymbols(value: unknown, files: readonly RepoMapFileRecord[]): RepoMapSymbolNode[] {
	assertShape(storageValidators.symbols, value, "symbols");
	const fileIds = new Set(files.map((file) => file.id));
	for (const symbol of value) {
		if (!fileIds.has(symbol.fileId) || !isValidSourceRange(symbol) || symbol.id !== createSymbolId({
			fileId: symbol.fileId,
			kind: symbol.symbolKind,
			...(symbol.name !== undefined ? { name: symbol.name } : {}),
			...(symbol.qualifiedName !== undefined ? { qualifiedName: symbol.qualifiedName } : {}),
			startByte: symbol.startByte,
		})) throw new Error("invalid symbol semantics");
	}
	assertStrictOrder(value, compareSymbol, "symbols");
	return value;
}

function validateTests(
	value: unknown,
	files: readonly RepoMapFileRecord[],
	symbols: readonly RepoMapSymbolNode[],
): RepoMapTestNode[] {
	assertShape(storageValidators.tests, value, "tests");
	const fileIds = new Set(files.map((file) => file.id));
	const symbolIds = new Set(symbols.map((symbol) => symbol.id));
	for (const node of value) {
		for (const evidence of node.evidence) validateEvidence(evidence);
		if (!fileIds.has(node.fileId) || (node.symbolId !== undefined && !symbolIds.has(node.symbolId))) throw new Error("dangling test node");
		if (node.testKind === "file" && node.symbolId !== undefined) throw new Error("invalid test file node");
	}
	assertStrictOrder(value, compareTestNode, "tests");
	return value;
}

function validateArchitecture(value: unknown, files: readonly RepoMapFileRecord[]): RepoMapArchitectureNode[] {
	assertShape(storageValidators.architecture, value, "architecture");
	const fileIds = new Set(files.map((file) => file.id));
	const ids = new Set<string>();
	for (const node of value) {
		if (ids.has(node.id)) throw new Error("duplicate architecture node");
		if (node.kind !== "entrypoint" && !isRepoRootPath(node.rootPath)) throw new Error("invalid architecture path");
		if (node.kind === "package" && node.manifestPath !== undefined && !isSafeRelativePath(node.manifestPath)) throw new Error("invalid manifest path");
		if (node.kind === "entrypoint" && node.fileId !== undefined && !fileIds.has(node.fileId)) throw new Error("dangling entrypoint file");
		ids.add(node.id);
	}
	if (value.some((node) => node.kind === "component" && !ids.has(node.packageId))
		|| value.some((node) => node.kind === "entrypoint" && node.packageId !== undefined && !ids.has(node.packageId))) throw new Error("dangling architecture owner");
	assertStrictOrder(value, compareArchitecture, "architecture");
	return value;
}

function validateAliases(
	value: unknown,
	mapId: string,
	files: readonly RepoMapFileRecord[],
	symbols: readonly RepoMapSymbolNode[],
	architecture: readonly RepoMapArchitectureNode[],
	tests: readonly RepoMapTestNode[],
): RepoMapLexicalAlias[] {
	assertShape(storageValidators.aliases, value, "aliases");
	const targets = new Set([`repository:${mapId}`, ...files.map((file) => file.id), ...symbols.map((symbol) => symbol.id), ...architecture.map((node) => node.id), ...tests.map((node) => node.id)]);
	for (const alias of value) {
		if (!isLexicalTerm(alias.term) || !isLexicalTerm(alias.canonical) || !targets.has(alias.target)) throw new Error("invalid alias semantics");
		for (const evidence of alias.evidence) validateEvidence(evidence, true);
	}
	assertStrictOrder(value, compareAlias, "aliases");
	return value;
}

function validateEdges(
	value: unknown,
	mapId: string,
	files: readonly RepoMapFileRecord[],
	symbols: readonly RepoMapSymbolNode[],
	architecture: readonly RepoMapArchitectureNode[],
	tests: readonly RepoMapTestNode[],
): RepoMapEdge[] {
	assertShape(storageValidators.edges, value, "edges");
	const nodes = new Set([`repository:${mapId}`, ...files.map((file) => file.id), ...symbols.map((symbol) => symbol.id), ...architecture.map((node) => node.id), ...tests.map((node) => node.id)]);
	for (const edge of value) {
		if (!nodes.has(edge.from) || (!nodes.has(edge.to) && !edge.to.startsWith("external:") && !edge.to.startsWith("lexical:symbol:"))) {
			throw new Error("dangling edge");
		}
		for (const evidence of edge.evidence) validateEvidence(evidence);
	}
	assertStrictOrder(value, compareRepoMapEdge, "edges");
	return value;
}

function validateEvidence(value: RepoMapEvidence, diagnosticPath = false): RepoMapEvidence {
	if (!(diagnosticPath ? isSafeDiagnosticPath(value.path) : isSafeRelativePath(value.path)) || !isValidSourceRange(value)) {
		throw new Error("invalid evidence semantics");
	}
	return value;
}

function validateDiagnostics(value: unknown): RepoMapDiagnostic[] {
	assertShape(storageValidators.diagnostics, value, "diagnostics");
	if (value.some((diagnostic) => diagnostic.path !== undefined && !isSafeDiagnosticPath(diagnostic.path))) throw new Error("invalid diagnostic path");
	return value;
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
	try {
		return await lock(mapDirectory, {
			lockfilePath: path.join(mapDirectory, "COMMIT_LOCK"),
			realpath: false,
			stale: 10 * 60 * 1000,
			retries: 0,
		});
	} catch (error) {
		throw new RepoMapError("CACHE_ERROR", "Another Repo Map commit is already in progress.", error);
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

interface RuntimeValidator<T> {
	Check(value: unknown): value is T;
}

function assertShape<T>(validator: RuntimeValidator<T>, value: unknown, label: string): asserts value is T {
	if (!validator.Check(value)) throw new Error(`invalid ${label} shape`);
}

function assertStrictOrder<T>(values: readonly T[], compare: (left: T, right: T) => number, label: string): void {
	for (let index = 1; index < values.length; index += 1) {
		const previous = values[index - 1];
		const current = values[index];
		if (previous === undefined || current === undefined || compare(previous, current) >= 0) throw new Error(`invalid ${label} order`);
	}
}

function countsAreSafe(metadata: RepoMapMetadata): boolean {
	return [
		metadata.fileCount, metadata.indexedFileCount, metadata.parsedFileCount, metadata.unsupportedFileCount,
		metadata.parseErrorFileCount, metadata.symbolCount, metadata.testNodeCount, metadata.edgeCount,
		metadata.aliasCount, metadata.tooLargeFileCount, metadata.diagnosticCount,
	].every(Number.isSafeInteger);
}

function isSafeRelativePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) return false;
	const normalized = path.posix.normalize(value);
	return normalized === value && value !== "." && value !== ".." && !value.startsWith("../");
}

function isSafeDiagnosticPath(value: unknown): value is string {
	return value === "." || isSafeRelativePath(value) || (typeof value === "string" && value.startsWith("<") && value.endsWith(">"));
}

function isErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isIsoDate(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isCanonicalAbsolutePath(value: string): boolean {
	return path.isAbsolute(value) && !value.includes("\0") && path.normalize(value) === value;
}

function isRepoRootPath(value: unknown): value is string {
	return value === "." || isSafeRelativePath(value);
}

function isValidSourceRange(value: { startLine: number; endLine: number; startByte: number; endByte: number }): boolean {
	return Number.isSafeInteger(value.startLine)
		&& Number.isSafeInteger(value.endLine)
		&& Number.isSafeInteger(value.startByte)
		&& Number.isSafeInteger(value.endByte)
		&& value.endLine >= value.startLine
		&& value.endByte >= value.startByte;
}

function isLexicalTerm(value: unknown): value is string {
	return typeof value === "string" && value.length >= 3 && value.length <= 256 && value === value.toLocaleLowerCase() && !value.includes("\0");
}

function compareSymbol(left: RepoMapSymbolNode, right: RepoMapSymbolNode): number {
	return compareText(left.fileId, right.fileId) || left.startByte - right.startByte || compareText(left.id, right.id);
}

function compareArchitecture(left: RepoMapArchitectureNode, right: RepoMapArchitectureNode): number {
	return compareText(left.kind, right.kind) || compareText(left.id, right.id);
}

function compareTestNode(left: RepoMapTestNode, right: RepoMapTestNode): number {
	return compareText(left.fileId, right.fileId)
		|| compareText(left.testKind, right.testKind)
		|| compareText(left.id, right.id);
}

function architectureSnapshot(node: RepoMapArchitectureNode): unknown[] {
	if (node.kind === "package") return [node.kind, node.id, node.name, node.rootPath, node.ecosystem, node.manifestPath ?? null, node.source, node.confidence];
	if (node.kind === "component") return [node.kind, node.id, node.name, node.rootPath, node.packageId, node.source, node.confidence];
	return [node.kind, node.id, node.name, node.entrypointType, node.packageId ?? null, node.fileId ?? null, node.declaredTarget ?? null, node.source, node.confidence];
}

function compareDiagnostic(left: RepoMapDiagnostic, right: RepoMapDiagnostic): number {
	return compareText(left.path ?? "", right.path ?? "") || compareText(left.code, right.code) || compareText(left.message, right.message);
}

function sortedEdges(edges: readonly RepoMapEdge[]): RepoMapEdge[] {
	return [...edges]
		.sort(compareRepoMapEdge)
		.map((edge) => ({ ...edge, evidence: [...edge.evidence].sort(compareRepoMapEvidence) }));
}

function sortedAliases(aliases: readonly RepoMapLexicalAlias[]): RepoMapLexicalAlias[] {
	return [...aliases]
		.sort(compareAlias)
		.map((alias) => ({ ...alias, evidence: [...alias.evidence].sort(compareRepoMapEvidence) }));
}

function sortedTests(tests: readonly RepoMapTestNode[]): RepoMapTestNode[] {
	return [...tests]
		.sort(compareTestNode)
		.map((node) => ({ ...node, evidence: [...node.evidence].sort(compareRepoMapEvidence) }));
}

function compareAlias(left: RepoMapLexicalAlias, right: RepoMapLexicalAlias): number {
	return compareText(left.term, right.term)
		|| compareText(left.canonical, right.canonical)
		|| compareText(left.target, right.target)
		|| compareText(left.source, right.source);
}
