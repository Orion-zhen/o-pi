import path from "node:path";

import { normalizeIndexPath } from "./identity.js";
import type { AnalyzedFileIndex, CodeAuthority, CodeLanguage, IndexedCodeUnit, ModuleImport } from "./types.js";

interface Definition {
	readonly path: string;
	readonly unit: IndexedCodeUnit;
}

interface DefinitionGroup {
	readonly exported: Definition[];
	readonly byPath: Map<string, Definition[]>;
}

interface Origin {
	readonly path: string;
	readonly definitions: readonly string[];
	readonly unitId: string;
}

const AUTHORITY_PRIORITY = { called: 0, referenced: 1, defined: 2 } as const;

/** 以当前已解析文件构造保守的词法依赖图；不修改可复用的 AST cache。 */
export function inferCodeAuthorities(files: readonly AnalyzedFileIndex[]): AnalyzedFileIndex[] {
	const parsed = files.filter((file) => file.status === "parsed");
	if (parsed.length === 0) return [...files];
	const simple = new Map<string, DefinitionGroup>();
	const qualified = new Map<string, DefinitionGroup>();
	for (const file of parsed) {
		for (const unit of file.units) {
			const definition = { path: file.path, unit };
			addDefinition(simple, symbolLeaf(unit.name), definition);
			addDefinition(qualified, normalizeSymbol(unit.qualifiedName ?? unit.name), definition);
		}
	}

	const modulePaths = modulePathIndex(parsed);
	const importsByPath = new Map(parsed.map((file) => [
		file.path,
		resolveImportedPaths(file.path, file.language, file.imports, modulePaths),
	]));
	const resolved = new Map<string, Definition | undefined>();
	const authorities = new Map<string, CodeAuthority>();

	for (const file of parsed) {
		for (const unit of file.units) {
			const origin: Origin = {
				path: file.path,
				unitId: unit.id,
				definitions: normalizedDefinitions(unit.definitions),
			};
			promoteRelations(origin, unit.calls, "called");
			promoteRelations(origin, unit.references, "referenced");
		}
	}

	if (authorities.size === 0) return [...files];
	return files.map((file) => {
		let changed = false;
		const units = file.units.map((unit) => {
			const authority = authorities.get(unit.id);
			if (authority === undefined || authority === unit.authority) return unit;
			changed = true;
			return { ...unit, authority };
		});
		return changed ? { ...file, units } : file;
	});

	function promoteRelations(origin: Origin, relations: readonly string[], authority: CodeAuthority): void {
		for (const relation of relations) {
			const normalized = normalizeSymbol(relation);
			const leaf = symbolLeaf(normalized);
			if (normalized.length === 0 || origin.definitions.includes(leaf)) continue;
			const key = `${origin.path}\0${normalized}`;
			let target: Definition | undefined;
			if (resolved.has(key)) target = resolved.get(key);
			else {
				target = resolveDefinition(
					origin.path,
					normalized,
					simple,
					qualified,
					importsByPath.get(origin.path) ?? new Set(),
				);
				resolved.set(key, target);
			}
			if (target === undefined || target.unit.id === origin.unitId) continue;
			const current = authorities.get(target.unit.id) ?? target.unit.authority;
			if (AUTHORITY_PRIORITY[authority] < AUTHORITY_PRIORITY[current]) authorities.set(target.unit.id, authority);
		}
	}
}

function resolveDefinition(
	originPath: string,
	relation: string,
	simple: ReadonlyMap<string, DefinitionGroup>,
	qualified: ReadonlyMap<string, DefinitionGroup>,
	importedPaths: ReadonlySet<string>,
): Definition | undefined {
	const group = relation.includes(".") ? qualified.get(relation) : simple.get(symbolLeaf(relation));
	if (group === undefined) return undefined;
	const local = group.byPath.get(originPath) ?? [];
	if (local.length > 0) return only(local);
	const imported = importedDefinitions(group, importedPaths);
	if (imported.length > 0) return only(imported);
	return only(group.exported);
}

function importedDefinitions(group: DefinitionGroup, importedPaths: ReadonlySet<string>): Definition[] {
	const result: Definition[] = [];
	for (const importedPath of importedPaths) {
		for (const definition of group.byPath.get(importedPath) ?? []) {
			if (definition.unit.exported) result.push(definition);
		}
	}
	return result;
}

function addDefinition(groups: Map<string, DefinitionGroup>, name: string, definition: Definition): void {
	if (name.length === 0) return;
	let group = groups.get(name);
	if (group === undefined) {
		group = { exported: [], byPath: new Map() };
		groups.set(name, group);
	}
	const inFile = group.byPath.get(definition.path);
	if (inFile === undefined) group.byPath.set(definition.path, [definition]);
	else inFile.push(definition);
	if (definition.unit.exported) group.exported.push(definition);
}

function modulePathIndex(files: readonly AnalyzedFileIndex[]): Map<string, Set<string>> {
	const result = new Map<string, Set<string>>();
	for (const file of files) {
		const normalized = normalizeIndexPath(file.path);
		addModulePath(result, normalized, file.path);
		const extension = path.posix.extname(normalized);
		const stem = extension.length === 0 ? normalized : normalized.slice(0, -extension.length);
		addModuleAliases(result, stem, file.path);
		if (path.posix.basename(stem) === "index") addModuleAliases(result, path.posix.dirname(stem), file.path);
	}
	return result;
}

function addModuleAliases(index: Map<string, Set<string>>, modulePath: string, filePath: string): void {
	addModulePath(index, modulePath, filePath);
	for (let separator = modulePath.indexOf("/"); separator >= 0; separator = modulePath.indexOf("/", separator + 1)) {
		addModulePath(index, modulePath.slice(separator + 1), filePath);
	}
}

function addModulePath(index: Map<string, Set<string>>, key: string, filePath: string): void {
	if (key.length === 0 || key === ".") return;
	const values = index.get(key);
	if (values === undefined) index.set(key, new Set([filePath]));
	else values.add(filePath);
}

function resolveImportedPaths(
	sourcePath: string,
	language: CodeLanguage,
	imports: readonly ModuleImport[],
	modulePaths: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
	const result = new Set<string>();
	for (const imported of imports) {
		for (const key of importKeys(sourcePath, language, imported)) {
			const paths = modulePaths.get(key);
			if (paths === undefined) continue;
			for (const filePath of paths) result.add(filePath);
			break;
		}
	}
	return result;
}

function importKeys(sourcePath: string, language: CodeLanguage, imported: ModuleImport): string[] {
	const specifier = imported.specifier.trim().replaceAll("\\", "/").replace(/::\*$/u, "");
	if (specifier.length === 0) return [];
	const directory = path.posix.dirname(normalizeIndexPath(sourcePath));
	if (language === "python" && specifier.startsWith(".")) {
		let dots = 0;
		while (specifier[dots] === ".") dots += 1;
		let base = directory;
		for (let index = 1; index < dots; index += 1) base = path.posix.dirname(base);
		return lookupKeys(path.posix.join(base, specifier.slice(dots).replaceAll(".", "/")));
	}
	if (specifier.startsWith("./") || specifier.startsWith("../") || imported.importKind === "relative") {
		return lookupKeys(path.posix.join(directory, specifier));
	}
	if (language === "python") {
		return lookupKeys(specifier.replaceAll(".", "/"));
	}
	if (language === "rust" && specifier.includes("::")) {
		const parts = specifier.split("::").filter(Boolean);
		let base = "";
		while (parts[0] === "self" || parts[0] === "super" || parts[0] === "crate") {
			const prefix = parts.shift();
			if (prefix === "self") base = directory;
			else if (prefix === "super") base = path.posix.dirname(base.length === 0 ? directory : base);
		}
		const keys: string[] = [];
		for (let length = parts.length; length > 0; length -= 1) {
			keys.push(...lookupKeys(path.posix.join(base, ...parts.slice(0, length))));
		}
		return unique(keys);
	}
	return [];
}

function lookupKeys(value: string): string[] {
	const normalized = normalizeIndexPath(value);
	const extension = path.posix.extname(normalized);
	return unique([
		normalized,
		...(extension.length === 0 ? [] : [normalized.slice(0, -extension.length)]),
	]);
}

function normalizedDefinitions(values: readonly string[]): string[] {
	return values.map((value) => symbolLeaf(normalizeSymbol(value)));
}

function normalizeSymbol(value: string): string {
	return value.replace(/::|#/gu, ".").replaceAll("?.", ".").replaceAll("->", ".");
}

function symbolLeaf(value: string): string {
	const normalized = normalizeSymbol(value);
	return normalized.slice(normalized.lastIndexOf(".") + 1);
}

function only(values: readonly Definition[]): Definition | undefined {
	return values.length === 1 ? values[0] : undefined;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}
