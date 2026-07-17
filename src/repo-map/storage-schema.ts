import { Type } from "typebox";
import { Compile } from "typebox/compile";

import { REPO_MAP_SCHEMA_VERSION } from "./identity.js";
import type {
	RepoMapArchitectureNode,
	RepoMapDiagnostic,
	RepoMapEdge,
	RepoMapFileRecord,
	RepoMapLexicalAlias,
	RepoMapMetadata,
	RepoMapSymbolNode,
	RepoMapTestNode,
} from "./types.js";

const objectOptions = { additionalProperties: false } as const;
const nonEmptyString = Type.String({ minLength: 1 });
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const confidence = Type.Number({ minimum: 0, maximum: 1 });
const count = Type.Integer({ minimum: 0 });
const sourceRange = {
	startLine: Type.Integer({ minimum: 1 }),
	endLine: Type.Integer({ minimum: 1 }),
	startByte: count,
	endByte: count,
};

const EvidenceSchema = Type.Object({
	path: nonEmptyString,
	textHash: Type.Optional(hash),
	...sourceRange,
}, objectOptions);

const MetadataSchema = Type.Unsafe<RepoMapMetadata>(Type.Object({
	schemaVersion: Type.Literal(REPO_MAP_SCHEMA_VERSION),
	mapId: hash,
	repositoryRoot: nonEmptyString,
	worktreeRoot: nonEmptyString,
	gitCommonDir: nonEmptyString,
	generation: hash,
	createdAt: nonEmptyString,
	updatedAt: nonEmptyString,
	freshness: Type.Union([Type.Literal("fresh"), Type.Literal("partially_stale"), Type.Literal("stale"), Type.Literal("unavailable")]),
	fileCount: count,
	indexedFileCount: count,
	parsedFileCount: count,
	unsupportedFileCount: count,
	parseErrorFileCount: count,
	symbolCount: count,
	testNodeCount: count,
	edgeCount: count,
	aliasCount: count,
	tooLargeFileCount: count,
	diagnosticCount: count,
	gitRevision: Type.Optional(Type.String({ pattern: "^[0-9a-f]{40,64}$" })),
	configFingerprint: hash,
	ignoreFingerprint: nonEmptyString,
	parserFingerprint: nonEmptyString,
}, objectOptions));

const FileSchema = Type.Unsafe<RepoMapFileRecord>(Type.Object({
	id: nonEmptyString,
	path: nonEmptyString,
	size: Type.Number({ minimum: 0 }),
	mtimeMs: Type.Number({ minimum: 0 }),
	status: Type.Union([Type.Literal("indexed"), Type.Literal("too_large"), Type.Literal("unreadable"), Type.Literal("unstable")]),
	contentHash: Type.Optional(hash),
}, objectOptions));

const SymbolSchema = Type.Unsafe<RepoMapSymbolNode>(Type.Object({
	kind: Type.Literal("symbol"),
	id: nonEmptyString,
	fileId: nonEmptyString,
	symbolKind: nonEmptyString,
	name: Type.Optional(nonEmptyString),
	qualifiedName: Type.Optional(nonEmptyString),
	signature: Type.Optional(Type.String()),
	...sourceRange,
	definitions: Type.Array(Type.String()),
	references: Type.Array(Type.String()),
	calls: Type.Array(Type.String()),
	imports: Type.Array(Type.String()),
	visibility: Type.Optional(Type.Union([Type.Literal("public"), Type.Literal("internal")])),
}, objectOptions));

const TestSchema = Type.Unsafe<RepoMapTestNode>(Type.Object({
	kind: Type.Literal("test"),
	id: nonEmptyString,
	testKind: Type.Union([Type.Literal("file"), Type.Literal("symbol")]),
	name: nonEmptyString,
	fileId: nonEmptyString,
	symbolId: Type.Optional(nonEmptyString),
	source: Type.Union([Type.Literal("syntax"), Type.Literal("manifest"), Type.Literal("convention")]),
	confidence,
	evidence: Type.Array(EvidenceSchema, { minItems: 1 }),
}, objectOptions));

const architectureBase = {
	id: nonEmptyString,
	name: nonEmptyString,
	source: Type.Union([Type.Literal("manifest"), Type.Literal("convention"), Type.Literal("syntactic")]),
	confidence,
};
const ArchitectureSchema = Type.Unsafe<RepoMapArchitectureNode>(Type.Union([
	Type.Object({
		kind: Type.Literal("package"),
		...architectureBase,
		rootPath: nonEmptyString,
		ecosystem: Type.Union([Type.Literal("npm"), Type.Literal("python"), Type.Literal("go"), Type.Literal("cargo"), Type.Literal("repository")]),
		manifestPath: Type.Optional(nonEmptyString),
	}, objectOptions),
	Type.Object({
		kind: Type.Literal("component"),
		...architectureBase,
		rootPath: nonEmptyString,
		packageId: nonEmptyString,
	}, objectOptions),
	Type.Object({
		kind: Type.Literal("entrypoint"),
		...architectureBase,
		entrypointType: Type.Union([
			Type.Literal("main"), Type.Literal("module"), Type.Literal("bin"), Type.Literal("export"), Type.Literal("script"),
			Type.Literal("test"), Type.Literal("command"), Type.Literal("tool"), Type.Literal("plugin"),
		]),
		packageId: Type.Optional(nonEmptyString),
		fileId: Type.Optional(nonEmptyString),
		declaredTarget: Type.Optional(nonEmptyString),
	}, objectOptions),
]));

const AliasSchema = Type.Unsafe<RepoMapLexicalAlias>(Type.Object({
	term: Type.String({ minLength: 3, maxLength: 256 }),
	canonical: Type.String({ minLength: 3, maxLength: 256 }),
	target: nonEmptyString,
	source: Type.Union([
		Type.Literal("file-path"), Type.Literal("symbol"), Type.Literal("signature"), Type.Literal("import-alias"),
		Type.Literal("export-alias"), Type.Literal("architecture"), Type.Literal("registration"), Type.Literal("config-key"),
		Type.Literal("environment"), Type.Literal("doc-comment"),
	]),
	confidence,
	evidence: Type.Array(EvidenceSchema, { minItems: 1 }),
}, objectOptions));

const EdgeSchema = Type.Unsafe<RepoMapEdge>(Type.Object({
	from: nonEmptyString,
	to: nonEmptyString,
	kind: Type.Union([
		Type.Literal("contains"), Type.Literal("belongs-to"), Type.Literal("imports"), Type.Literal("exports"),
		Type.Literal("references"), Type.Literal("calls"), Type.Literal("declares-entrypoint"), Type.Literal("declares-script"),
		Type.Literal("registers-command"), Type.Literal("registers-tool"), Type.Literal("registers-plugin"),
		Type.Literal("exports-publicly"), Type.Literal("re-exports"), Type.Literal("tests"), Type.Literal("mocks"),
		Type.Literal("uses-fixture"), Type.Literal("uses-snapshot"), Type.Literal("configured-by"),
	]),
	resolution: Type.Union([Type.Literal("lexical"), Type.Literal("syntactic"), Type.Literal("semantic")]),
	source: Type.Union([Type.Literal("tree-sitter"), Type.Literal("syntax"), Type.Literal("manifest"), Type.Literal("lsp"), Type.Literal("convention")]),
	confidence,
	lexicalTarget: Type.Optional(nonEmptyString),
	evidence: Type.Array(EvidenceSchema, { minItems: 1 }),
}, objectOptions));

const DiagnosticSchema = Type.Unsafe<RepoMapDiagnostic>(Type.Object({
	code: nonEmptyString,
	message: nonEmptyString,
	path: Type.Optional(nonEmptyString),
}, objectOptions));

export const storageValidators = {
	metadata: Compile(MetadataSchema),
	files: Compile(Type.Array(FileSchema)),
	symbols: Compile(Type.Array(SymbolSchema)),
	tests: Compile(Type.Array(TestSchema)),
	architecture: Compile(Type.Array(ArchitectureSchema)),
	aliases: Compile(Type.Array(AliasSchema)),
	edges: Compile(Type.Array(EdgeSchema)),
	diagnostics: Compile(Type.Array(DiagnosticSchema)),
} as const;
