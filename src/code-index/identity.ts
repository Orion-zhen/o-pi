import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { registeredLanguageAdapters } from "./language-registry.js";
import type { FileIdentity, SymbolIdentityInput } from "./types.js";

/** Extractor format changes invalidate parser-dependent Repo Map generations. */
export const CODE_INDEX_EXTRACTOR_FORMAT = "code-index-extractor-v3";

export interface ParserFingerprintInput {
	extractorFormat?: string;
	runtimeVersion?: string;
	grammars?: readonly ParserGrammarFingerprint[];
}

export interface ParserGrammarFingerprint {
	packageName: string;
	version: string;
	exportName?: string;
}

const require = createRequire(import.meta.url);

/** Stable parser identity; metadata resolution never imports native runtime or grammar modules. */
export const CODE_INDEX_FORMAT_VERSION = createParserFingerprint();

export function createParserFingerprint(input: ParserFingerprintInput = {}): string {
	const grammars = input.grammars ?? registeredLanguageAdapters().map((adapter) => ({
		packageName: adapter.grammar.packageName,
		...(adapter.grammar.exportName !== undefined ? { exportName: adapter.grammar.exportName } : {}),
		version: installedPackageVersion(adapter.grammar.packageName) ?? "missing",
	}));
	const grammarParts = [...grammars]
		.sort((left, right) => compareText(left.packageName, right.packageName) || compareText(left.exportName ?? "", right.exportName ?? "") || compareText(left.version, right.version))
		.map((grammar) => `grammar=${grammar.packageName}@${grammar.version}#${grammar.exportName ?? ""}`);
	const parts = [
		`extractor=${input.extractorFormat ?? CODE_INDEX_EXTRACTOR_FORMAT}`,
		`runtime=tree-sitter@${input.runtimeVersion ?? installedPackageVersion("tree-sitter") ?? "missing"}`,
		...grammarParts,
	];
	return `code-index-parser-${createHash("sha256").update(parts.join("\n")).digest("hex")}`;
}

/** 生成不依赖 cwd 或文件系统状态的索引内部路径。 */
export function normalizeIndexPath(filePath: string): string {
	const slashPath = filePath.replace(/\\/gu, "/");
	const normalized = path.posix.normalize(slashPath);
	return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

export function createFileIdentity(filePath: string): FileIdentity {
	const normalizedPath = normalizeIndexPath(filePath);
	return { id: `file:${normalizedPath}`, path: normalizedPath };
}

export function createSymbolId(input: SymbolIdentityInput): string {
	const symbolName = input.qualifiedName ?? input.name ?? "";
	return ["symbol", input.fileId, input.kind, symbolName, String(input.startByte)]
		.map((part) => encodeURIComponent(part))
		.join(":");
}

function installedPackageVersion(packageName: string): string | undefined {
	let entry: string;
	try {
		entry = require.resolve(packageName);
	} catch {
		return undefined;
	}
	let directory = path.dirname(entry);
	while (true) {
		const packageJson = path.join(directory, "package.json");
		try {
			const value: unknown = JSON.parse(readFileSync(packageJson, "utf8"));
			if (isRecord(value) && value["name"] === packageName && typeof value["version"] === "string") return value["version"];
		} catch {
			// Continue toward the filesystem root; optional packages may be absent or malformed.
		}
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
