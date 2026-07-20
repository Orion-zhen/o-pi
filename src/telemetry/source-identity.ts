import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JsonObject } from "./types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMPORT_PATTERN = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)/gu;
const ALL_IMPORT_PATTERN = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/gu;

export interface SourceDigest {
	path: string;
	sha256: string;
}

export interface DependencyDigest {
	package: string;
	version?: string;
	integrity?: string;
}

export interface SourceBundle {
	sources: SourceDigest[];
	dependencies: DependencyDigest[];
}

export type SourceReference = string | URL;

interface CachedSource {
	mtimeMs: number;
	size: number;
	digest: SourceDigest;
	relativeImports: string[];
	packages: string[];
}

const sourceCache = new Map<string, CachedSource>();
const dependencyCache = new Map<string, DependencyDigest[]>();

/** Content-address the complete local relative-import closure of the entrypoints. */
export function sourceGraph(entrypoints: readonly SourceReference[]): SourceDigest[] {
	return collectSourceGraph(entrypoints).sources;
}

/** Local source closure plus the installed dependency-lock subgraph it imports. */
export function sourceBundle(entrypoints: readonly SourceReference[]): SourceBundle {
	const graph = collectSourceGraph(entrypoints);
	return { sources: graph.sources, dependencies: lockedDependencies(graph.packages) };
}

export function sourceBundleDescriptor(entrypoints: readonly SourceReference[]): JsonObject {
	const bundle = sourceBundle(entrypoints);
	return {
		files: bundle.sources.map((source) => ({ path: source.path, sha256: source.sha256 })),
		dependencies: bundle.dependencies.map((dependency) => ({ package: dependency.package,
			...(dependency.version === undefined ? {} : { version: dependency.version }),
			...(dependency.integrity === undefined ? {} : { integrity: dependency.integrity }) })),
	};
}

function collectSourceGraph(entrypoints: readonly SourceReference[]): SourceBundle & { packages: Set<string> } {
	const pending = entrypoints.map(resolveEntrypoint);
	const visited = new Set<string>();
	const files: SourceDigest[] = [];
	const packages = new Set<string>();
	while (pending.length > 0) {
		const file = pending.pop();
		if (file === undefined || visited.has(file)) continue;
		visited.add(file);
		if (!isFileInsideRoot(file)) throw new Error(`Invalid identity entrypoint: ${path.relative(ROOT, file)}`);
		const source = readSource(file);
		files.push({ ...source.digest });
		for (const packageValue of source.packages) packages.add(packageValue);
		for (const specifier of source.relativeImports) {
			const resolved = resolveSourceImport(file, specifier);
			if (resolved !== undefined && !visited.has(resolved)) pending.push(resolved);
		}
	}
	return { sources: files.sort((left, right) => left.path.localeCompare(right.path)), dependencies: [], packages };
}

function resolveEntrypoint(entrypoint: SourceReference): string {
	if (entrypoint instanceof URL) return fileURLToPath(entrypoint);
	if (entrypoint.startsWith("file:")) return fileURLToPath(entrypoint);
	return path.isAbsolute(entrypoint) ? entrypoint : path.resolve(ROOT, entrypoint);
}

function importedPackages(content: string): string[] {
	const imports: string[] = [];
	for (const match of content.matchAll(ALL_IMPORT_PATTERN)) {
		const specifier = match[1] ?? match[2];
		if (specifier !== undefined && !specifier.startsWith(".") && !specifier.startsWith("node:")) imports.push(specifier);
	}
	return imports;
}

function packageName(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] ?? specifier;
}

let cachedLockPackages: Record<string, unknown> | undefined;

function lockedDependencies(initial: ReadonlySet<string>): DependencyDigest[] {
	const cacheKey = [...initial].sort().join("\0");
	const cached = dependencyCache.get(cacheKey);
	if (cached !== undefined) return cached.map((item) => ({ ...item }));
	const lockPackages = packageLockPackages();
	const pending = [...initial].sort();
	const visited = new Set<string>();
	const result: DependencyDigest[] = [];
	while (pending.length > 0) {
		const name = pending.shift();
		if (name === undefined || visited.has(name)) continue;
		visited.add(name);
		const value = lockPackages[`node_modules/${name}`];
		if (!isRecord(value)) {
			result.push({ package: name });
			continue;
		}
		result.push({ package: name,
			...(typeof value["version"] === "string" ? { version: value["version"] } : {}),
			...(typeof value["integrity"] === "string" ? { integrity: value["integrity"] } : {}) });
		const dependencies = value["dependencies"];
		if (isRecord(dependencies)) for (const dependency of Object.keys(dependencies).sort()) if (!visited.has(dependency)) pending.push(dependency);
	}
	const sorted = result.sort((left, right) => left.package.localeCompare(right.package));
	dependencyCache.set(cacheKey, sorted);
	return sorted.map((item) => ({ ...item }));
}

function readSource(file: string): CachedSource {
	const metadata = statSync(file);
	const cached = sourceCache.get(file);
	if (cached !== undefined && cached.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) return cached;
	const content = readFileSync(file, "utf8");
	const source: CachedSource = {
		mtimeMs: metadata.mtimeMs,
		size: metadata.size,
		digest: { path: relativePath(file), sha256: sha256(content) },
		relativeImports: relativeImports(content),
		packages: importedPackages(content).map(packageName),
	};
	sourceCache.set(file, source);
	return source;
}

function packageLockPackages(): Record<string, unknown> {
	if (cachedLockPackages !== undefined) return cachedLockPackages;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
		if (isRecord(parsed) && isRecord(parsed["packages"])) cachedLockPackages = parsed["packages"];
	} catch {
		// A missing lockfile is represented by dependency entries without version metadata.
	}
	return cachedLockPackages ?? {};
}

function relativeImports(content: string): string[] {
	const imports: string[] = [];
	for (const match of content.matchAll(IMPORT_PATTERN)) {
		const specifier = match[1] ?? match[2];
		if (specifier !== undefined) imports.push(specifier);
	}
	return imports;
}

function resolveSourceImport(importer: string, specifier: string): string | undefined {
	const base = path.resolve(path.dirname(importer), specifier);
	const extension = path.extname(base);
	const candidates = extension === ".js" || extension === ".mjs" || extension === ".cjs"
		? [base.slice(0, -extension.length) + ".ts", base.slice(0, -extension.length) + ".tsx"]
		: extension.length > 0 ? [base] : [base + ".ts", base + ".tsx", path.join(base, "index.ts")];
	return candidates.find(isFileInsideRoot);
}

function isFileInsideRoot(file: string): boolean {
	const relative = path.relative(ROOT, file);
	if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(file)) return false;
	return statSync(file).isFile();
}

function relativePath(file: string): string {
	return path.relative(ROOT, file).replace(/\\/gu, "/");
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
