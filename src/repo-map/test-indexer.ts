import path from "node:path";
import { parse as parseToml } from "smol-toml";

import { throwIfAborted } from "./errors.js";
import { coalesceRepoMapEdges, compareText, groupBy, uniqueBy } from "./graph.js";
import { fileEvidence, rangeEvidence, readTextNoFollow, sha256, sourceEvidence, type RepoMapReadText, type RepoMapSourceFile } from "./source.js";
import { javascriptSyntaxFacts, type JavaScriptSyntaxFacts, type NamedSyntaxFact } from "./syntax-facts.js";
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
	readText?: RepoMapReadText;
}

export interface RepoMapTestGraph {
	nodes: RepoMapTestNode[];
	edges: RepoMapEdge[];
	diagnostics: RepoMapDiagnostic[];
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
	const readText = input.readText ?? readTextNoFollow;
	const testFiles = input.files.filter((file) => file.status === "indexed" && isTestFile(file.path));
	const configurationFiles = input.files.filter((file) => file.status === "indexed" && isConfigurationFile(file.path));
	const filesToRead = new Map([...testFiles, ...configurationFiles].map((file) => [file.id, file]));
	const sources = new Map<string, RepoMapSourceFile>();
	const diagnostics: RepoMapDiagnostic[] = [];
	for (const file of filesToRead.values()) {
		throwIfAborted(input.signal);
		try {
			const text = await readText(path.join(input.root, file.path), input.signal);
			if (file.contentHash === undefined || sha256(text) !== file.contentHash) {
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
	const symbolsByFile = groupBy(input.symbols, (symbol) => symbol.fileId);
	const nodes: RepoMapTestNode[] = [];
	const edges: RepoMapEdge[] = [];
	for (const testFile of testFiles) {
		const source = sources.get(testFile.id);
		if (source === undefined) continue;
		const syntax = javascriptSyntaxFacts(testFile.path, source.text);
		const fileNode = testFileNode(source);
		nodes.push(fileNode);
		edges.push(edge(testFile.id, fileNode.id, "contains", "convention", fileNode.confidence, fileNode.evidence[0]));

		const caseNodes = testCaseNodes(source, symbolsByFile.get(testFile.id) ?? [], syntax.tests);
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

		for (const fact of resourceFacts(source, syntax.mocks)) {
			const target = resolveModuleTarget(testFile.path, fact.target, filesByPath, input.edges);
			edges.push(edge(fileNode.id, target.id, "mocks", "syntax", target.resolved ? 0.94 : 0.58, fact.evidence, fact.target));
		}
		for (const fact of resourceFacts(source, syntax.fixtures)) {
			const target = resolveModuleTarget(testFile.path, fact.target, filesByPath, input.edges);
			edges.push(edge(fileNode.id, target.id, "uses-fixture", "syntax", target.resolved ? 0.9 : 0.52, fact.evidence, fact.target));
		}
		for (const fact of snapshotFacts(source, syntax)) {
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
		edges: coalesceRepoMapEdges(edges),
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

function testFileNode(source: RepoMapSourceFile): RepoMapTestNode {
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

function testCaseNodes(source: RepoMapSourceFile, symbols: readonly RepoMapSymbolNode[], syntaxFacts: readonly NamedSyntaxFact[]): RepoMapTestNode[] {
	const symbolFacts = symbols.filter((symbol) => symbol.name !== undefined && (/^test_/u.test(symbol.name) || /^Test\p{Lu}/u.test(symbol.name)));
	return [
		...syntaxFacts.map((fact) => ({ name: fact.name, range: fact })),
		...symbolFacts.map((symbol) => ({ name: symbol.name ?? "test", range: symbol, symbolId: symbol.id })),
	].map((fact) => {
		const evidence = rangeEvidence(source, fact.range);
		return {
			kind: "test",
			id: testNodeId(source.file.id, "symbol", fact.name, fact.range.startByte),
			testKind: "symbol",
			name: fact.name,
			fileId: source.file.id,
			...("symbolId" in fact ? { symbolId: fact.symbolId } : {}),
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
		.sort((left, right) => (right.name?.length ?? 0) - (left.name?.length ?? 0) || compareText(left.id, right.id));
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

function resourceFacts(source: RepoMapSourceFile, facts: readonly NamedSyntaxFact[]): Array<{ target: string; evidence: RepoMapEvidence }> {
	return facts.map((fact) => ({ target: fact.name, evidence: rangeEvidence(source, fact) }));
}

function snapshotFacts(source: RepoMapSourceFile, syntax: JavaScriptSyntaxFacts): Array<{ name: string; evidence: RepoMapEvidence }> {
	return syntax.snapshots.map((fact) => ({ name: fact.name, evidence: rangeEvidence(source, fact) }));
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
	sources: ReadonlyMap<string, RepoMapSourceFile>,
): RepoMapFileRecord[] {
	return configurations
		.filter((file) => isAncestor(path.posix.dirname(file.path), testPath) && configurationDeclaresTests(file, sources.get(file.id)?.text ?? ""))
		.sort((left, right) => path.posix.dirname(right.path).length - path.posix.dirname(left.path).length || compareText(left.path, right.path))
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
	if (basename === "pyproject.toml") {
		try {
			const value = parseToml(text);
			const tool = value["tool"];
			return "pytest" in value || "coverage" in value || isRecord(tool) && ("pytest" in tool || "coverage" in tool);
		} catch {
			return false;
		}
	}
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
	return `test:${sha256([fileId, kind, name, start].join("\0"))}`;
}

function evidenceForNeedle(source: RepoMapSourceFile, needle: string): RepoMapEvidence {
	const start = Math.max(0, source.text.indexOf(needle));
	return evidenceForRange(source, start, start + (start === 0 && !source.text.startsWith(needle) ? 0 : needle.length));
}

function evidenceForRange(source: RepoMapSourceFile, start: number, end: number): RepoMapEvidence {
	return sourceEvidence(source, start, end);
}

function uniqueNodes(values: readonly RepoMapTestNode[]): RepoMapTestNode[] {
	return uniqueBy(values, (value) => value.id)
		.sort((left, right) => compareText(left.fileId, right.fileId) || compareText(left.testKind, right.testKind) || compareText(left.id, right.id));
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
