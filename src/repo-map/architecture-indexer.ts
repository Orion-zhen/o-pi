import path from "node:path";
import { parse as parseToml } from "smol-toml";

import { languageFromPath } from "../code-index/parser.js";
import { throwIfAborted } from "./errors.js";
import { coalesceRepoMapEdges, compareText, uniqueBy } from "./graph.js";
import { fileEvidence, rangeEvidence, readTextNoFollow, sha256, sourceEvidence, symbolEvidence, type RepoMapReadText, type RepoMapSourceFile } from "./source.js";
import { javascriptSyntaxFacts, type RegistrationFact } from "./syntax-facts.js";
import type {
	RepoMapArchitectureNode,
	RepoMapComponentNode,
	RepoMapDiagnostic,
	RepoMapEdge,
	RepoMapEntrypointNode,
	RepoMapEntrypointType,
	RepoMapEvidence,
	RepoMapFileRecord,
	RepoMapPackageNode,
	RepoMapSymbolNode,
} from "./types.js";

export interface BuildRepoMapArchitectureInput {
	root: string;
	mapId: string;
	files: readonly RepoMapFileRecord[];
	symbols: readonly RepoMapSymbolNode[];
	previous?: {
		files: readonly RepoMapFileRecord[];
		architecture: readonly RepoMapArchitectureNode[];
		edges: readonly RepoMapEdge[];
		diagnostics: readonly RepoMapDiagnostic[];
	};
	signal?: AbortSignal;
	readText?: RepoMapReadText;
}

export interface RepoMapArchitectureIndex {
	nodes: RepoMapArchitectureNode[];
	edges: RepoMapEdge[];
	symbols: RepoMapSymbolNode[];
	diagnostics: RepoMapDiagnostic[];
}

interface PackageDraft {
	node: RepoMapPackageNode;
	evidence: RepoMapEvidence;
	manifest?: RepoMapSourceFile;
}

interface ManifestEntrypoint {
	name: string;
	type: RepoMapEntrypointType;
	target: string;
	script: boolean;
}

const MANIFEST_NAMES = new Set(["package.json", "pyproject.toml", "go.mod", "Cargo.toml"]);
const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"];

/** Build deterministic package/component/entrypoint facts without executing repository code. */
export async function buildRepoMapArchitecture(input: BuildRepoMapArchitectureInput): Promise<RepoMapArchitectureIndex> {
	throwIfAborted(input.signal);
	const readText = input.readText ?? readTextNoFollow;
	const filesByPath = new Map(input.files.map((file) => [file.path, file]));
	const filesById = new Map(input.files.map((file) => [file.id, file]));
	const symbolsByFile = groupByFile(input.symbols);
	const reusableSourcePaths = reusableArchitectureSourcePaths(input);
	const sourceFiles = new Map<string, RepoMapSourceFile>();
	const diagnostics: RepoMapDiagnostic[] = [];
	const shouldRead = (file: RepoMapFileRecord): boolean => file.status === "indexed"
		&& (MANIFEST_NAMES.has(path.posix.basename(file.path)) || isScriptFile(file.path) && !reusableSourcePaths.has(file.path));
	for (const file of input.files) {
		if (!shouldRead(file)) continue;
		throwIfAborted(input.signal);
		try {
			const text = await readText(path.join(input.root, file.path), input.signal);
			if (file.contentHash === undefined || sha256(text) !== file.contentHash) {
				diagnostics.push({ code: "ARCHITECTURE_FILE_CHANGED", message: "File changed while architecture facts were indexed.", path: file.path });
				continue;
			}
			sourceFiles.set(file.path, { file, text });
		} catch {
			diagnostics.push({ code: "ARCHITECTURE_FILE_UNREADABLE", message: "File could not be read while architecture facts were indexed.", path: file.path });
		}
	}

	const packages = discoverPackages(input.root, input.files, sourceFiles, diagnostics);
	const packageForFile = new Map<string, PackageDraft>();
	for (const file of input.files) {
		const owner = deepestPackage(packages, file.path);
		if (owner !== undefined) packageForFile.set(file.id, owner);
	}
	const components = discoverComponents(input.files, packageForFile);
	const componentForFile = new Map<string, RepoMapComponentNode>();
	for (const file of input.files) {
		const owner = packageForFile.get(file.id);
		if (owner === undefined) continue;
		const component = componentFor(owner.node, file.path, components);
		if (component !== undefined) componentForFile.set(file.id, component);
	}

	const nodes: RepoMapArchitectureNode[] = [...packages.map((item) => item.node), ...components];
	const edges: RepoMapEdge[] = [];
	const repositoryId = `repository:${input.mapId}`;
	for (const item of packages) edges.push(edge(repositoryId, item.node.id, "contains", "manifest", item.node.confidence, item.evidence));
	for (const component of components) {
		const evidence = componentEvidence(component, input.files, componentForFile);
		if (evidence !== undefined) edges.push(edge(component.packageId, component.id, "contains", "convention", component.confidence, evidence));
	}
	for (const file of input.files) {
		const owner = packageForFile.get(file.id);
		const component = componentForFile.get(file.id);
		const evidence = fileEvidence(file);
		if (owner !== undefined) edges.push(edge(file.id, owner.node.id, "belongs-to", owner.node.source === "manifest" ? "manifest" : "convention", owner.node.confidence, evidence));
		if (component !== undefined) edges.push(edge(file.id, component.id, "belongs-to", "convention", component.confidence, evidence));
	}
	for (const symbol of input.symbols) {
		const file = filesById.get(symbol.fileId);
		if (file === undefined) continue;
		const owner = packageForFile.get(file.id);
		const component = componentForFile.get(file.id);
		const evidence = symbolEvidence(file, symbol);
		if (owner !== undefined) edges.push(edge(symbol.id, owner.node.id, "belongs-to", owner.node.source === "manifest" ? "manifest" : "convention", owner.node.confidence, evidence));
		if (component !== undefined) edges.push(edge(symbol.id, component.id, "belongs-to", "convention", component.confidence, evidence));
	}

	const publicFiles = new Set<string>();
	for (const item of packages) {
		for (const declaration of manifestEntrypoints(item, diagnostics)) {
			const resolved = resolveDeclaredTarget(item.node.rootPath, declaration.target, filesByPath);
			const evidence = item.manifest === undefined ? item.evidence : evidenceForText(item.manifest, declaration.target);
			const entrypoint = makeEntrypoint(item.node, declaration, resolved?.id);
			nodes.push(entrypoint);
			edges.push(edge(item.node.id, entrypoint.id, declaration.script ? "declares-script" : "declares-entrypoint", "manifest", 1, evidence, declaration.target));
			if (resolved !== undefined) {
				edges.push(edge(entrypoint.id, resolved.id, "contains", "manifest", 0.98, evidence, declaration.target));
				if (declaration.type === "main" || declaration.type === "module" || declaration.type === "export" || declaration.type === "bin") {
					publicFiles.add(resolved.id);
					edges.push(edge(item.node.id, resolved.id, "exports-publicly", "manifest", 0.98, evidence, declaration.target));
				}
			}
		}
	}

	const reExportedSymbols = new Set<string>();
	const symbolsById = new Map(input.symbols.map((symbol) => [symbol.id, symbol]));
	const reusedEntrypoints = (input.previous?.architecture ?? []).filter((node): node is RepoMapEntrypointNode =>
		node.kind === "entrypoint" && node.fileId !== undefined && reusableSourcePaths.has(filesById.get(node.fileId)?.path ?? "") && node.source !== "manifest");
	const reusedEntrypointIds = new Set(reusedEntrypoints.map((node) => node.id));
	const previousEntrypointComponentEdges = new Map((input.previous?.edges ?? [])
		.filter((candidate) => candidate.kind === "belongs-to" && reusedEntrypointIds.has(candidate.from))
		.map((candidate) => [candidate.from, candidate]));
	for (const previousNode of reusedEntrypoints) {
		const owner = previousNode.fileId === undefined ? undefined : packageForFile.get(previousNode.fileId);
		const { packageId: _oldPackageId, ...node } = previousNode;
		nodes.push(owner === undefined ? node : { ...node, packageId: owner.node.id });
		const component = previousNode.fileId === undefined ? undefined : componentForFile.get(previousNode.fileId);
		const file = previousNode.fileId === undefined ? undefined : filesById.get(previousNode.fileId);
		if (component !== undefined && file !== undefined) {
			const previousEdge = previousEntrypointComponentEdges.get(previousNode.id);
			edges.push(previousEdge === undefined
				? edge(previousNode.id, component.id, "belongs-to", "convention", component.confidence, fileEvidence(file))
				: { ...previousEdge, to: component.id });
		}
	}
	for (const previousEdge of input.previous?.edges ?? []) {
		const sourcePath = filesById.get(previousEdge.from)?.path;
		if (sourcePath === undefined || !reusableSourcePaths.has(sourcePath) || !isReusableArchitectureSourceEdge(previousEdge)) continue;
		if (previousEdge.kind === "exports-publicly"
			&& !symbolsById.has(previousEdge.to)
			&& !reusedEntrypointIds.has(previousEdge.to)) continue;
		edges.push(previousEdge);
		if (previousEdge.kind === "exports-publicly" && symbolsById.has(previousEdge.to)) reExportedSymbols.add(previousEdge.to);
	}
	for (const source of sourceFiles.values()) {
		if (!isJavaScriptFamily(source.file.path)) continue;
		const syntax = javascriptSyntaxFacts(source.file.path, source.text);
		const owner = packageForFile.get(source.file.id);
		const component = componentForFile.get(source.file.id);
		for (const fact of syntax.registrations) {
			const entrypoint = registrationEntrypoint(fact, source.file, owner?.node);
			const evidence = rangeEvidence(source, fact);
			nodes.push(entrypoint);
			edges.push(edge(source.file.id, entrypoint.id, registrationEdgeKind(fact.type), "syntax", entrypoint.confidence, evidence, fact.name));
			if (component !== undefined) edges.push(edge(entrypoint.id, component.id, "belongs-to", "convention", component.confidence, evidence));
		}
		const defaultExport = syntax.defaultExports[0];
		if (defaultExport !== undefined && isExtensionConvention(source.file.path)) {
			const entrypoint = conventionPluginEntrypoint(source.file, owner?.node);
			nodes.push(entrypoint);
			edges.push(edge(source.file.id, entrypoint.id, "registers-plugin", "convention", 0.72, rangeEvidence(source, defaultExport)));
		}
		for (const fact of syntax.reExports) {
			const target = resolveDeclaredTarget(path.posix.dirname(source.file.path), fact.target, filesByPath);
			const evidence = rangeEvidence(source, fact);
			if (target === undefined) {
				edges.push(edge(source.file.id, `external:${encodeURIComponent(fact.target)}`, "re-exports", "syntax", 0.45, evidence, fact.target));
				continue;
			}
			edges.push(edge(source.file.id, target.id, "re-exports", "syntax", 0.94, evidence, fact.target));
			const targetSymbols = (symbolsByFile.get(target.id) ?? []).filter((symbol) => isRequestedExport(symbol, fact.names));
			for (const symbol of targetSymbols) {
				reExportedSymbols.add(symbol.id);
				edges.push(edge(source.file.id, symbol.id, "exports-publicly", "syntax", 0.92, evidence, symbol.name));
			}
			if (publicFiles.has(source.file.id)) publicFiles.add(target.id);
		}
		for (const exported of syntax.defaultExports) {
			const entrypoint: RepoMapEntrypointNode = {
				kind: "entrypoint",
				id: architectureId("entrypoint", source.file.id, "export", "default"),
				name: "default",
				entrypointType: "export",
				...(owner !== undefined ? { packageId: owner.node.id } : {}),
				fileId: source.file.id,
				source: "syntactic",
				confidence: 0.96,
			};
			nodes.push(entrypoint);
			edges.push(edge(source.file.id, entrypoint.id, "exports-publicly", "syntax", 0.96, rangeEvidence(source, exported)));
		}
	}
	let publicFileAdded = true;
	while (publicFileAdded) {
		publicFileAdded = false;
		for (const candidate of edges) {
			if (candidate.kind !== "re-exports" || !publicFiles.has(candidate.from) || publicFiles.has(candidate.to) || !filesById.has(candidate.to)) continue;
			publicFiles.add(candidate.to);
			publicFileAdded = true;
		}
	}

	const symbols = input.symbols.map((symbol) => {
		const publicSymbol = isModulePublic(symbol, filesById)
			|| reExportedSymbols.has(symbol.id);
		return { ...symbol, visibility: publicSymbol ? "public" as const : "internal" as const };
	});
	for (const symbol of symbols) {
		if (symbol.visibility !== "public") continue;
		const owner = packageForFile.get(symbol.fileId);
		const file = filesById.get(symbol.fileId);
		if (owner !== undefined && file !== undefined) edges.push(edge(
			owner.node.id,
			symbol.id,
			"exports-publicly",
			owner.node.source === "manifest" ? "manifest" : "convention",
			publicFiles.has(symbol.fileId) ? 0.96 : owner.node.source === "manifest" ? 0.78 : 0.68,
			symbolEvidence(file, symbol),
		));
	}

	return {
		nodes: uniqueNodes(nodes),
		edges: coalesceRepoMapEdges(edges),
		symbols,
		diagnostics,
	};
}

function reusableArchitectureSourcePaths(input: BuildRepoMapArchitectureInput): Set<string> {
	const previous = input.previous;
	if (previous === undefined || previous.files.length !== input.files.length
		|| previous.diagnostics.some((diagnostic) => diagnostic.code.startsWith("ARCHITECTURE_") && diagnostic.path === undefined)) return new Set();
	const currentByPath = new Map(input.files.map((file) => [file.path, file]));
	const previousByPath = new Map(previous.files.map((file) => [file.path, file]));
	if ([...currentByPath.keys()].some((filePath) => !previousByPath.has(filePath))) return new Set();
	const retryPaths = new Set(previous.diagnostics
		.filter((diagnostic) => diagnostic.code.startsWith("ARCHITECTURE_"))
		.flatMap((diagnostic) => diagnostic.path === undefined ? [] : [diagnostic.path]));
	const reusable = new Set(input.files.filter((file) => {
		const old = previousByPath.get(file.path);
		return isScriptFile(file.path) && file.status === "indexed" && old?.status === "indexed"
			&& old.contentHash === file.contentHash && !retryPaths.has(file.path);
	}).map((file) => file.path));
	const pathsById = new Map(input.files.map((file) => [file.id, file.path]));
	let removed = true;
	while (removed) {
		removed = false;
		for (const candidate of previous.edges) {
			if (candidate.kind !== "re-exports") continue;
			const sourcePath = pathsById.get(candidate.from);
			const targetPath = pathsById.get(candidate.to);
			if (sourcePath !== undefined && reusable.has(sourcePath) && targetPath !== undefined && !reusable.has(targetPath)) {
				reusable.delete(sourcePath);
				removed = true;
			}
		}
	}
	return reusable;
}

function isReusableArchitectureSourceEdge(edgeValue: RepoMapEdge): boolean {
	return edgeValue.kind === "registers-command"
		|| edgeValue.kind === "registers-tool"
		|| edgeValue.kind === "registers-plugin"
		|| edgeValue.kind === "re-exports"
		|| edgeValue.kind === "exports-publicly";
}

function discoverPackages(
	root: string,
	files: readonly RepoMapFileRecord[],
	sources: ReadonlyMap<string, RepoMapSourceFile>,
	diagnostics: RepoMapDiagnostic[],
): PackageDraft[] {
	const result: PackageDraft[] = [];
	for (const source of sources.values()) {
		const manifestName = path.posix.basename(source.file.path);
		if (!MANIFEST_NAMES.has(manifestName)) continue;
		const packageRoot = path.posix.dirname(source.file.path) === "." ? "." : path.posix.dirname(source.file.path);
		const parsed = manifestPackage(manifestName, source.text, packageRoot, root);
		if (parsed === undefined) {
			diagnostics.push({ code: "ARCHITECTURE_MANIFEST_INVALID", message: "Manifest could not be parsed for package metadata.", path: source.file.path });
			continue;
		}
		const node: RepoMapPackageNode = {
			kind: "package",
			id: architectureId("package", parsed.ecosystem, packageRoot, parsed.name),
			name: parsed.name,
			rootPath: packageRoot,
			ecosystem: parsed.ecosystem,
			manifestPath: source.file.path,
			source: "manifest",
			confidence: 1,
		};
		result.push({ node, evidence: fileEvidence(source.file), manifest: source });
	}
	if (result.length === 0) {
		const first = files[0];
		if (first !== undefined) {
			const name = path.basename(root);
			result.push({
				node: { kind: "package", id: architectureId("package", "repository", ".", name), name, rootPath: ".", ecosystem: "repository", source: "convention", confidence: 0.65 },
				evidence: fileEvidence(first),
			});
		}
	}
	return result.sort((left, right) => right.node.rootPath.length - left.node.rootPath.length || compareText(left.node.id, right.node.id));
}

function manifestPackage(
	manifestName: string,
	text: string,
	packageRoot: string,
	repositoryRoot: string,
): { name: string; ecosystem: RepoMapPackageNode["ecosystem"] } | undefined {
	if (manifestName === "package.json") {
		try {
			const value = JSON.parse(text) as unknown;
			if (!isRecord(value)) return undefined;
			const name = typeof value["name"] === "string" && value["name"].length > 0 ? value["name"] : fallbackPackageName(packageRoot, repositoryRoot);
			return { name, ecosystem: "npm" };
		} catch { return undefined; }
	}
	if (manifestName === "pyproject.toml") return { name: tomlPackageName(text, "project") ?? fallbackPackageName(packageRoot, repositoryRoot), ecosystem: "python" };
	if (manifestName === "go.mod") return { name: capture(text, /^\s*module\s+(\S+)/mu) ?? fallbackPackageName(packageRoot, repositoryRoot), ecosystem: "go" };
	if (manifestName === "Cargo.toml") return { name: tomlPackageName(text, "package") ?? fallbackPackageName(packageRoot, repositoryRoot), ecosystem: "cargo" };
	return undefined;
}

function manifestEntrypoints(item: PackageDraft, diagnostics: RepoMapDiagnostic[]): ManifestEntrypoint[] {
	const source = item.manifest;
	if (source === undefined) return [];
	const name = path.posix.basename(source.file.path);
	if (name === "package.json") {
		try {
			const value = JSON.parse(source.text) as unknown;
			if (!isRecord(value)) return [];
			const result: ManifestEntrypoint[] = [];
			for (const type of ["main", "module"] as const) if (typeof value[type] === "string") result.push({ name: type, type, target: value[type], script: false });
			const bin = value["bin"];
			if (typeof bin === "string") result.push({ name: item.node.name, type: "bin", target: bin, script: false });
			else if (isRecord(bin)) for (const [key, target] of Object.entries(bin)) if (typeof target === "string") result.push({ name: key, type: "bin", target, script: false });
			for (const exported of flattenExports(value["exports"])) result.push({ name: exported.name, type: "export", target: exported.target, script: false });
			const scripts = value["scripts"];
			if (isRecord(scripts)) for (const [key, target] of Object.entries(scripts)) if (typeof target === "string") result.push({ name: key, type: /^test(?::|$)/u.test(key) ? "test" : "script", target, script: true });
			return result;
		} catch {
			diagnostics.push({ code: "ARCHITECTURE_MANIFEST_INVALID", message: "package.json entrypoints could not be parsed.", path: source.file.path });
			return [];
		}
	}
	if (name === "pyproject.toml") {
		try {
			const parsed = parseToml(source.text);
			const project = parsed["project"];
			const scripts = isRecord(project) ? project["scripts"] : undefined;
			return isRecord(scripts)
				? Object.entries(scripts).flatMap(([scriptName, target]) => typeof target === "string"
					? [{ name: scriptName, type: "bin" as const, target, script: false }] : [])
				: [];
		} catch {
			diagnostics.push({ code: "ARCHITECTURE_MANIFEST_INVALID", message: "pyproject.toml entrypoints could not be parsed.", path: source.file.path });
			return [];
		}
	}
	return [];
}

function flattenExports(value: unknown, key = "."): Array<{ name: string; target: string }> {
	if (typeof value === "string") return [{ name: key, target: value }];
	if (!isRecord(value)) return [];
	const result: Array<{ name: string; target: string }> = [];
	for (const [childKey, child] of Object.entries(value)) result.push(...flattenExports(child, childKey.startsWith(".") ? childKey : key));
	return result;
}

function discoverComponents(
	files: readonly RepoMapFileRecord[],
	owners: ReadonlyMap<string, PackageDraft>,
): RepoMapComponentNode[] {
	const result = new Map<string, RepoMapComponentNode>();
	for (const file of files) {
		const owner = owners.get(file.id);
		if (owner === undefined) continue;
		const relative = relativeToPackage(owner.node.rootPath, file.path);
		const segment = relative.includes("/") ? relative.slice(0, relative.indexOf("/")) : "root";
		const rootPath = segment === "root" ? owner.node.rootPath : joinRepoPath(owner.node.rootPath, segment);
		const id = architectureId("component", owner.node.id, segment);
		result.set(id, { kind: "component", id, name: segment, rootPath, packageId: owner.node.id, source: "convention", confidence: segment === "root" ? 0.78 : 0.88 });
	}
	return [...result.values()].sort((left, right) => compareText(left.id, right.id));
}

function deepestPackage(packages: readonly PackageDraft[], filePath: string): PackageDraft | undefined {
	return packages.find((item) => item.node.rootPath === "." || filePath === item.node.rootPath || filePath.startsWith(`${item.node.rootPath}/`));
}

function componentFor(owner: RepoMapPackageNode, filePath: string, components: readonly RepoMapComponentNode[]): RepoMapComponentNode | undefined {
	const relative = relativeToPackage(owner.rootPath, filePath);
	const segment = relative.includes("/") ? relative.slice(0, relative.indexOf("/")) : "root";
	return components.find((component) => component.packageId === owner.id && component.name === segment);
}

function componentEvidence(component: RepoMapComponentNode, files: readonly RepoMapFileRecord[], owners: ReadonlyMap<string, RepoMapComponentNode>): RepoMapEvidence | undefined {
	const file = files.find((candidate) => owners.get(candidate.id)?.id === component.id);
	return file === undefined ? undefined : fileEvidence(file);
}

function makeEntrypoint(owner: RepoMapPackageNode, declaration: ManifestEntrypoint, fileId: string | undefined): RepoMapEntrypointNode {
	return {
		kind: "entrypoint",
		id: architectureId("entrypoint", owner.id, declaration.type, declaration.name, declaration.target),
		name: declaration.name,
		entrypointType: declaration.type,
		packageId: owner.id,
		...(fileId !== undefined ? { fileId } : {}),
		declaredTarget: declaration.target,
		source: "manifest",
		confidence: fileId === undefined ? 0.72 : 1,
	};
}

function registrationEntrypoint(fact: RegistrationFact, file: RepoMapFileRecord, owner: RepoMapPackageNode | undefined): RepoMapEntrypointNode {
	return {
		kind: "entrypoint",
		id: architectureId("entrypoint", file.id, fact.type, fact.name),
		name: fact.name,
		entrypointType: fact.type,
		...(owner !== undefined ? { packageId: owner.id } : {}),
		fileId: file.id,
		declaredTarget: fact.name,
		source: "syntactic",
		confidence: fact.dynamic ? 0.62 : 0.96,
	};
}

function registrationEdgeKind(type: RegistrationFact["type"]): "registers-command" | "registers-tool" | "registers-plugin" {
	return type === "command" ? "registers-command" : type === "tool" ? "registers-tool" : "registers-plugin";
}

function conventionPluginEntrypoint(file: RepoMapFileRecord, owner: RepoMapPackageNode | undefined): RepoMapEntrypointNode {
	return {
		kind: "entrypoint",
		id: architectureId("entrypoint", file.id, "plugin", "default"),
		name: path.posix.basename(file.path, path.posix.extname(file.path)),
		entrypointType: "plugin",
		...(owner !== undefined ? { packageId: owner.id } : {}),
		fileId: file.id,
		declaredTarget: "default export",
		source: "convention",
		confidence: 0.72,
	};
}

function resolveDeclaredTarget(
	basePath: string,
	declaredTarget: string,
	files: ReadonlyMap<string, RepoMapFileRecord>,
): RepoMapFileRecord | undefined {
	let target = declaredTarget.trim();
	if (/^(?:node|tsx?|python\d*|bun)\s+/u.test(target)) target = target.replace(/^\S+\s+/u, "").split(/\s+/u)[0] ?? target;
	if (target.includes(":")) return undefined;
	const clean = target.replace(/^\.\//u, "").split(/[?#]/u)[0] ?? target;
	const joined = path.posix.normalize(basePath === "." ? clean : path.posix.join(basePath, clean));
	const candidates = [joined];
	const extension = path.posix.extname(joined);
	if (extension === "") for (const item of CODE_EXTENSIONS) candidates.push(`${joined}${item}`, `${joined}/index${item}`);
	else if ([".js", ".mjs", ".cjs"].includes(extension)) for (const item of [".ts", ".tsx", ".js", ".jsx"]) candidates.push(`${joined.slice(0, -extension.length)}${item}`);
	return candidates.flatMap((candidate) => files.get(candidate) ?? []).at(0);
}

function isRequestedExport(symbol: RepoMapSymbolNode, names: "*" | ReadonlySet<string>): boolean {
	return names === "*" || (symbol.name !== undefined && names.has(symbol.name));
}

function isModulePublic(symbol: RepoMapSymbolNode, files: ReadonlyMap<string, RepoMapFileRecord>): boolean {
	const file = files.get(symbol.fileId);
	if (file === undefined || symbol.name === undefined || symbol.qualifiedName !== symbol.name) return false;
	const language = languageFromPath(file.path);
	if (["typescript", "tsx", "javascript", "jsx"].includes(language)) return /^export\b/u.test(symbol.signature ?? "");
	if (language === "python") return !symbol.name.startsWith("_");
	if (language === "go") return /^\p{Lu}/u.test(symbol.name);
	if (language === "rust") return /^pub(?:\([^)]*\))?\s/u.test(symbol.signature ?? "");
	return false;
}

function groupByFile(symbols: readonly RepoMapSymbolNode[]): Map<string, RepoMapSymbolNode[]> {
	const result = new Map<string, RepoMapSymbolNode[]>();
	for (const symbol of symbols) {
		const group = result.get(symbol.fileId);
		if (group === undefined) result.set(symbol.fileId, [symbol]);
		else group.push(symbol);
	}
	return result;
}

function isExtensionConvention(filePath: string): boolean {
	return filePath.startsWith("agent/extensions/") || /(?:^|\/)(?:extensions?|plugins?)(?:\/|$)/u.test(filePath);
}

function isScriptFile(filePath: string): boolean {
	return isJavaScriptFamily(filePath) || /\.(?:py|go|rs)$/u.test(filePath);
}

function isJavaScriptFamily(filePath: string): boolean {
	return /\.(?:[cm]?js|jsx|tsx?)$/u.test(filePath);
}

function uniqueNodes(nodes: readonly RepoMapArchitectureNode[]): RepoMapArchitectureNode[] {
	return uniqueBy([...nodes].sort((left, right) => left.confidence - right.confidence), (node) => node.id)
		.sort((left, right) => compareText(left.kind, right.kind) || compareText(left.id, right.id));
}

function edge(
	from: string,
	to: string,
	kind: RepoMapEdge["kind"],
	source: RepoMapEdge["source"],
	confidence: number,
	evidence: RepoMapEvidence,
	lexicalTarget?: string,
): RepoMapEdge {
	return { from, to, kind, resolution: source === "manifest" ? "syntactic" : source === "convention" ? "lexical" : "syntactic", source, confidence, ...(lexicalTarget !== undefined && lexicalTarget.length > 0 ? { lexicalTarget } : {}), evidence: [evidence] };
}

function evidenceForText(source: RepoMapSourceFile, needle: string): RepoMapEvidence {
	const index = source.text.indexOf(needle);
	return evidenceForRange(source, Math.max(0, index), Math.max(0, index) + needle.length);
}

function evidenceForRange(source: RepoMapSourceFile, startChar: number, endChar: number): RepoMapEvidence {
	return sourceEvidence(source, startChar, endChar);
}

function architectureId(kind: string, ...parts: string[]): string {
	return `${kind}:${sha256(parts.join("\0"))}`;
}

function relativeToPackage(packageRoot: string, filePath: string): string {
	return packageRoot === "." ? filePath : path.posix.relative(packageRoot, filePath);
}

function joinRepoPath(left: string, right: string): string {
	return left === "." ? right : path.posix.join(left, right);
}

function fallbackPackageName(packageRoot: string, repositoryRoot: string): string {
	return packageRoot === "." ? path.basename(repositoryRoot) : path.posix.basename(packageRoot);
}

function capture(text: string, pattern: RegExp): string | undefined {
	return pattern.exec(text)?.[1];
}

function tomlPackageName(text: string, section: "project" | "package"): string | undefined {
	try {
		const value = parseToml(text)[section];
		return isRecord(value) && typeof value["name"] === "string" && value["name"].length > 0 ? value["name"] : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
