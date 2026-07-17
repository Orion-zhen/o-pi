import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { throwIfAborted } from "./errors.js";
import { compareRepoMapEdge } from "./graph-types.js";
import type {
	RepoMapDiagnostic,
	RepoMapEdge,
	RepoMapEvidence,
	RepoMapFileRecord,
	RepoMapSymbolNode,
	RepoMapTestNode,
} from "./types.js";

export interface BuildRepoMapTestGraphInput {
	root: string;
	files: readonly RepoMapFileRecord[];
	symbols: readonly RepoMapSymbolNode[];
	edges: readonly RepoMapEdge[];
	signal?: AbortSignal;
	readText?: (absolutePath: string, signal?: AbortSignal) => Promise<string>;
}

export interface RepoMapTestGraph {
	nodes: RepoMapTestNode[];
	edges: RepoMapEdge[];
	diagnostics: RepoMapDiagnostic[];
}

interface SourceFile {
	file: RepoMapFileRecord;
	text: string;
}

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"];
const TEST_DIRECTORY = /(?:^|\/)(?:tests?|specs?|__tests__)(?:\/|$)/iu;
const TEST_NAME = /(?:^test[_-]|[._-](?:test|spec)(?:[._-]|$)|_test$)/iu;
const FIXTURE_PATH = /(?:^|\/)(?:__fixtures__|fixtures?|testdata)(?:\/|$)/iu;
const MOCK_PATH = /(?:^|\/)(?:__mocks__|mocks?)(?:\/|$)|[._-]mock(?:[._-]|$)/iu;
const SNAPSHOT_PATH = /(?:^|\/)__snapshots__(?:\/|$)|\.snap$/iu;
const RUNNER_CONFIG = /(?:^|\/)(?:vitest|jest|playwright|cypress)\.config\.[^/]+$|(?:^|\/)karma\.conf\.[^/]+$|(?:^|\/)pytest\.ini$|(?:^|\/)tox\.ini$/iu;

/** Build candidate test relationships from repository-local, deterministic syntax and naming facts. */
export async function buildRepoMapTestGraph(input: BuildRepoMapTestGraphInput): Promise<RepoMapTestGraph> {
	throwIfAborted(input.signal);
	const readText = input.readText ?? defaultReadText;
	const testFiles = input.files.filter((file) => file.status === "indexed" && isTestFile(file.path));
	const configurationFiles = input.files.filter((file) => file.status === "indexed" && isConfigurationFile(file.path));
	const filesToRead = new Map([...testFiles, ...configurationFiles].map((file) => [file.id, file]));
	const sources = new Map<string, SourceFile>();
	const diagnostics: RepoMapDiagnostic[] = [];
	for (const file of filesToRead.values()) {
		throwIfAborted(input.signal);
		try {
			const text = await readText(path.join(input.root, file.path), input.signal);
			if (file.contentHash === undefined || hash(text) !== file.contentHash) {
				diagnostics.push({ code: "TEST_GRAPH_FILE_CHANGED", message: "File changed while test relationships were indexed.", path: file.path });
				continue;
			}
			sources.set(file.id, { file, text });
		} catch {
			diagnostics.push({ code: "TEST_GRAPH_FILE_UNREADABLE", message: "File could not be read while test relationships were indexed.", path: file.path });
		}
	}

	const filesById = new Map(input.files.map((file) => [file.id, file]));
	const filesByPath = new Map(input.files.map((file) => [file.path, file]));
	const symbolsByFile = group(input.symbols, (symbol) => symbol.fileId);
	const nodes: RepoMapTestNode[] = [];
	const edges: RepoMapEdge[] = [];
	for (const testFile of testFiles) {
		const source = sources.get(testFile.id);
		if (source === undefined) continue;
		const fileNode = testFileNode(source);
		nodes.push(fileNode);
		edges.push(edge(testFile.id, fileNode.id, "contains", "convention", fileNode.confidence, fileNode.evidence[0]));

		const caseNodes = testCaseNodes(source, symbolsByFile.get(testFile.id) ?? []);
		for (const node of caseNodes) {
			nodes.push(node);
			edges.push(edge(testFile.id, node.id, "contains", "syntax", node.confidence, node.evidence[0]));
			const target = symbolNamedByTest(node.name, input.symbols, testFile.id);
			if (target !== undefined) edges.push(edge(node.id, target.id, "tests", "syntax", 0.86, node.evidence[0], target.name));
		}

		for (const importEdge of input.edges.filter((candidate) => candidate.kind === "imports" && candidate.from === testFile.id)) {
			const target = filesById.get(importEdge.to);
			const relation = target === undefined ? "tests" : relationForResource(target.path) ?? "tests";
			if (relation === "tests" && (target === undefined || isTestFile(target.path) || isConfigurationFile(target.path))) continue;
			edges.push(edge(fileNode.id, importEdge.to, relation, importEdge.source, importEdge.confidence, importEdge.evidence[0], importEdge.lexicalTarget));
		}

		const conventionalTarget = sourceByNamingConvention(testFile.path, input.files);
		if (conventionalTarget !== undefined && !edges.some((candidate) => candidate.kind === "tests" && candidate.from === fileNode.id && candidate.to === conventionalTarget.id)) {
			edges.push(edge(fileNode.id, conventionalTarget.id, "tests", "convention", 0.68, fileNode.evidence[0], conventionalTarget.path));
		}

		for (const fact of mockFacts(source)) {
			const target = resolveModuleTarget(testFile.path, fact.target, filesByPath, input.edges);
			edges.push(edge(fileNode.id, target.id, "mocks", "syntax", target.resolved ? 0.94 : 0.58, fact.evidence, fact.target));
		}
		for (const fact of fixtureFacts(source)) {
			const target = resolveModuleTarget(testFile.path, fact.target, filesByPath, input.edges);
			edges.push(edge(fileNode.id, target.id, "uses-fixture", "syntax", target.resolved ? 0.9 : 0.52, fact.evidence, fact.target));
		}
		for (const fact of snapshotFacts(source)) {
			const snapshots = matchingSnapshots(testFile.path, input.files);
			if (snapshots.length === 0) {
				edges.push(edge(fileNode.id, `external:snapshot:${encodeURIComponent(fact.name)}`, "uses-snapshot", "syntax", 0.7, fact.evidence, fact.name));
			} else {
				for (const snapshot of snapshots.slice(0, 4)) edges.push(edge(fileNode.id, snapshot.id, "uses-snapshot", "convention", 0.9, fact.evidence, fact.name));
			}
		}

		for (const config of applicableConfigurations(testFile.path, configurationFiles, sources)) {
			const configSource = sources.get(config.id);
			if (configSource === undefined) continue;
			const evidence = evidenceForNeedle(configSource, "test");
			edges.push(edge(fileNode.id, config.id, "configured-by", path.posix.basename(config.path) === "package.json" ? "manifest" : "convention", 0.82, evidence, config.path));
		}
	}

	return {
		nodes: uniqueNodes(nodes),
		edges: coalesceEdges(edges),
		diagnostics,
	};
}

export function isTestFile(filePath: string): boolean {
	if (relationForResource(filePath) !== undefined || isConfigurationFile(filePath)) return false;
	const basename = path.posix.basename(filePath);
	const stem = basename.slice(0, basename.length - path.posix.extname(basename).length);
	return TEST_DIRECTORY.test(filePath) || TEST_NAME.test(stem);
}

function isConfigurationFile(filePath: string): boolean {
	const basename = path.posix.basename(filePath);
	return RUNNER_CONFIG.test(filePath) || basename === "package.json" || basename === "pyproject.toml";
}

function relationForResource(filePath: string): "mocks" | "uses-fixture" | "uses-snapshot" | undefined {
	if (MOCK_PATH.test(filePath)) return "mocks";
	if (FIXTURE_PATH.test(filePath)) return "uses-fixture";
	if (SNAPSHOT_PATH.test(filePath)) return "uses-snapshot";
	return undefined;
}

function testFileNode(source: SourceFile): RepoMapTestNode {
	const evidence = fileEvidence(source.file);
	return {
		kind: "test",
		id: testNodeId(source.file.id, "file", source.file.path, 0),
		testKind: "file",
		name: source.file.path,
		fileId: source.file.id,
		source: "convention",
		confidence: TEST_NAME.test(path.posix.basename(source.file.path)) ? 0.96 : 0.88,
		evidence: [evidence],
	};
}

function testCaseNodes(source: SourceFile, symbols: readonly RepoMapSymbolNode[]): RepoMapTestNode[] {
	const facts: Array<{ name: string; start: number; end: number; symbolId?: string }> = [];
	for (const match of source.text.matchAll(/\b(?:describe|it|test)\s*(?:\.\w+)?\s*\(\s*(["'`])([^"'`\n]{1,160})\1/gu)) {
		if (match.index === undefined || match[2] === undefined) continue;
		facts.push({ name: match[2], start: match.index, end: match.index + match[0].length });
	}
	for (const match of source.text.matchAll(/\b(?:def\s+(test_[A-Za-z_]\w*)|func\s+(Test[A-Za-z_]\w*)|fn\s+(test_[A-Za-z_]\w*))\b/gu)) {
		if (match.index === undefined) continue;
		const name = match[1] ?? match[2] ?? match[3];
		if (name === undefined) continue;
		const symbol = symbols.find((candidate) => candidate.name === name);
		facts.push({ name, start: match.index, end: match.index + match[0].length, ...(symbol !== undefined ? { symbolId: symbol.id } : {}) });
	}
	return facts.map((fact) => {
		const evidence = evidenceForRange(source, fact.start, fact.end);
		return {
			kind: "test",
			id: testNodeId(source.file.id, "symbol", fact.name, fact.start),
			testKind: "symbol",
			name: fact.name,
			fileId: source.file.id,
			...(fact.symbolId !== undefined ? { symbolId: fact.symbolId } : {}),
			source: "syntax",
			confidence: 0.96,
			evidence: [evidence],
		};
	});
}

function symbolNamedByTest(name: string, symbols: readonly RepoMapSymbolNode[], testFileId: string): RepoMapSymbolNode | undefined {
	const normalized = normalizeWords(name);
	const candidates = symbols
		.filter((symbol) => symbol.fileId !== testFileId && symbol.name !== undefined && symbol.name.length >= 3 && normalized.includes(normalizeWords(symbol.name)))
		.sort((left, right) => (right.name?.length ?? 0) - (left.name?.length ?? 0) || compare(left.id, right.id));
	const first = candidates[0];
	const second = candidates[1];
	return first !== undefined && (second === undefined || first.name?.length !== second.name?.length) ? first : undefined;
}

function sourceByNamingConvention(testPath: string, files: readonly RepoMapFileRecord[]): RepoMapFileRecord | undefined {
	const testStem = sourceStem(testPath);
	if (testStem.length < 2) return undefined;
	const candidates = files.filter((file) => !isTestFile(file.path) && relationForResource(file.path) === undefined && sourceStem(file.path) === testStem);
	if (candidates.length === 1) return candidates[0];
	const testDirectory = path.posix.dirname(testPath).replace(/(?:^|\/)(?:tests?|specs?|__tests__)(?=\/|$)/giu, "/src").replace(/^\//u, "");
	return candidates.find((candidate) => path.posix.dirname(candidate.path) === testDirectory);
}

function sourceStem(filePath: string): string {
	const basename = path.posix.basename(filePath);
	const withoutExtension = basename.slice(0, basename.length - path.posix.extname(basename).length);
	return withoutExtension.replace(/^test[_-]/iu, "").replace(/[._-](?:test|spec)$/iu, "").replace(/_test$/iu, "").toLocaleLowerCase();
}

function mockFacts(source: SourceFile): Array<{ target: string; evidence: RepoMapEvidence }> {
	const result: Array<{ target: string; evidence: RepoMapEvidence }> = [];
	for (const match of source.text.matchAll(/\b(?:vi|jest)\.mock\s*\(\s*["']([^"']+)["']|\b(?:mock\.patch|patch)\s*\(\s*["']([^"']+)["']/gu)) {
		if (match.index === undefined) continue;
		const target = match[1] ?? match[2];
		if (target !== undefined) result.push({ target, evidence: evidenceForRange(source, match.index, match.index + match[0].length) });
	}
	return result;
}

function fixtureFacts(source: SourceFile): Array<{ target: string; evidence: RepoMapEvidence }> {
	const result: Array<{ target: string; evidence: RepoMapEvidence }> = [];
	for (const match of source.text.matchAll(/["']([^"'\n]*(?:__fixtures__|fixtures?|testdata)[^"'\n]*)["']/giu)) {
		if (match.index === undefined || match[1] === undefined) continue;
		result.push({ target: match[1], evidence: evidenceForRange(source, match.index, match.index + match[0].length) });
	}
	return result;
}

function snapshotFacts(source: SourceFile): Array<{ name: string; evidence: RepoMapEvidence }> {
	const result: Array<{ name: string; evidence: RepoMapEvidence }> = [];
	for (const match of source.text.matchAll(/\btoMatch(?:Inline)?Snapshot\s*\(\s*(?:["'`]([^"'`\n]{1,160})["'`])?/gu)) {
		if (match.index === undefined) continue;
		result.push({ name: match[1] ?? "snapshot", evidence: evidenceForRange(source, match.index, match.index + match[0].length) });
	}
	return result;
}

function matchingSnapshots(testPath: string, files: readonly RepoMapFileRecord[]): RepoMapFileRecord[] {
	const basename = path.posix.basename(testPath).toLocaleLowerCase();
	const directory = path.posix.dirname(testPath);
	return files.filter((file) => relationForResource(file.path) === "uses-snapshot"
		&& path.posix.dirname(file.path) === path.posix.join(directory, "__snapshots__")
		&& path.posix.basename(file.path).toLocaleLowerCase().includes(basename));
}

function applicableConfigurations(
	testPath: string,
	configurations: readonly RepoMapFileRecord[],
	sources: ReadonlyMap<string, SourceFile>,
): RepoMapFileRecord[] {
	return configurations
		.filter((file) => isAncestor(path.posix.dirname(file.path), testPath) && configurationDeclaresTests(file, sources.get(file.id)?.text ?? ""))
		.sort((left, right) => path.posix.dirname(right.path).length - path.posix.dirname(left.path).length || compare(left.path, right.path))
		.slice(0, 4);
}

function configurationDeclaresTests(file: RepoMapFileRecord, text: string): boolean {
	const basename = path.posix.basename(file.path);
	if (basename === "package.json") {
		try {
			const value = JSON.parse(text) as unknown;
			return isRecord(value) && isRecord(value["scripts"]) && Object.keys(value["scripts"]).some((key) => /^test(?::|$)/u.test(key));
		} catch { return false; }
	}
	if (basename === "pyproject.toml") return /\[(?:tool\.)?(?:pytest|coverage)(?:\.|\])/iu.test(text);
	return RUNNER_CONFIG.test(file.path);
}

function resolveModuleTarget(
	importerPath: string,
	specifier: string,
	filesByPath: ReadonlyMap<string, RepoMapFileRecord>,
	edges: readonly RepoMapEdge[],
): { id: string; resolved: boolean } {
	const existingImport = edges.find((candidate) => candidate.kind === "imports" && candidate.lexicalTarget === specifier && filesByPath.get(importerPath)?.id === candidate.from);
	if (existingImport !== undefined && [...filesByPath.values()].some((file) => file.id === existingImport.to)) return { id: existingImport.to, resolved: true };
	for (const candidate of moduleCandidates(importerPath, specifier)) {
		const file = filesByPath.get(candidate);
		if (file !== undefined) return { id: file.id, resolved: true };
	}
	return { id: `external:${encodeURIComponent(specifier)}`, resolved: false };
}

function moduleCandidates(importerPath: string, specifier: string): string[] {
	if (!specifier.startsWith(".")) return [];
	const base = path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), specifier));
	const result = [base];
	if (path.posix.extname(base) === "") for (const extension of CODE_EXTENSIONS) result.push(`${base}${extension}`, `${base}/index${extension}`);
	return result;
}

function edge(
	from: string,
	to: string,
	kind: RepoMapEdge["kind"],
	source: RepoMapEdge["source"],
	confidence: number,
	evidence: RepoMapEvidence | undefined,
	lexicalTarget?: string,
): RepoMapEdge {
	const fallback: RepoMapEvidence = { path: "test-graph", startLine: 1, endLine: 1, startByte: 0, endByte: 0 };
	return {
		from,
		to,
		kind,
		resolution: source === "convention" ? "lexical" : source === "manifest" ? "syntactic" : "syntactic",
		source,
		confidence,
		...(lexicalTarget !== undefined ? { lexicalTarget } : {}),
		evidence: [evidence ?? fallback],
	};
}

function testNodeId(fileId: string, kind: RepoMapTestNode["testKind"], name: string, start: number): string {
	return `test:${createHash("sha256").update(fileId).update("\0").update(kind).update("\0").update(name).update("\0").update(String(start)).digest("hex")}`;
}

function evidenceForNeedle(source: SourceFile, needle: string): RepoMapEvidence {
	const start = Math.max(0, source.text.indexOf(needle));
	return evidenceForRange(source, start, start + (start === 0 && !source.text.startsWith(needle) ? 0 : needle.length));
}

function evidenceForRange(source: SourceFile, start: number, end: number): RepoMapEvidence {
	const prefix = source.text.slice(0, start);
	const selected = source.text.slice(start, end);
	const startByte = Buffer.byteLength(prefix);
	return {
		path: source.file.path,
		...(source.file.contentHash !== undefined ? { textHash: source.file.contentHash } : {}),
		startLine: lineAt(source.text, start),
		endLine: lineAt(source.text, Math.max(start, end - 1)),
		startByte,
		endByte: startByte + Buffer.byteLength(selected),
	};
}

function fileEvidence(file: RepoMapFileRecord): RepoMapEvidence {
	return { path: file.path, ...(file.contentHash !== undefined ? { textHash: file.contentHash } : {}), startLine: 1, endLine: 1, startByte: 0, endByte: 0 };
}

function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < Math.min(offset, text.length); index += 1) if (text.charCodeAt(index) === 10) line += 1;
	return line;
}

function coalesceEdges(values: readonly RepoMapEdge[]): RepoMapEdge[] {
	const result = new Map<string, RepoMapEdge>();
	for (const value of values) {
		const key = [value.kind, value.from, value.to, value.resolution, value.source, value.confidence, value.lexicalTarget ?? ""].join("\0");
		const existing = result.get(key);
		if (existing === undefined) result.set(key, { ...value, evidence: [...value.evidence] });
		else existing.evidence.push(...value.evidence);
	}
	for (const value of result.values()) value.evidence = uniqueEvidence(value.evidence);
	return [...result.values()].sort(compareRepoMapEdge);
}

function uniqueNodes(values: readonly RepoMapTestNode[]): RepoMapTestNode[] {
	return [...new Map(values.map((value) => [value.id, value])).values()]
		.sort((left, right) => compare(left.fileId, right.fileId) || compare(left.testKind, right.testKind) || compare(left.id, right.id));
}

function uniqueEvidence(values: readonly RepoMapEvidence[]): RepoMapEvidence[] {
	return [...new Map(values.map((value) => [[value.path, value.startByte, value.endByte, value.textHash ?? ""].join("\0"), value])).values()]
		.sort((left, right) => compare(left.path, right.path) || left.startByte - right.startByte || left.endByte - right.endByte);
}

function group<T>(values: readonly T[], key: (value: T) => string): ReadonlyMap<string, T[]> {
	const result = new Map<string, T[]>();
	for (const value of values) {
		const items = result.get(key(value)) ?? [];
		items.push(value);
		result.set(key(value), items);
	}
	return result;
}

function isAncestor(directory: string, filePath: string): boolean {
	return directory === "." || filePath.startsWith(`${directory}/`);
}

function normalizeWords(value: string): string {
	return value.replace(/([a-z\d])([A-Z])/gu, "$1 $2").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLocaleLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

async function defaultReadText(absolutePath: string, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
