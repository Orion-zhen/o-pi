import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export type ImportKind = "static" | "dynamic" | "type-only";

export interface ImportEdge {
	importer: string;
	specifier: string;
	kind: ImportKind;
	target?: string;
}

export async function repositoryImportEdges(...directories: string[]): Promise<ImportEdge[]> {
	const files = (await Promise.all(
		directories.map((directory) => collectTypeScriptFiles(path.join(REPO_ROOT, directory))),
	)).flat();
	return (await Promise.all(files.map(async (filePath) => (
		scanSourceImports(relativePath(filePath), await readFile(filePath, "utf8"), filePath)
	)))).flat();
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(entries.map(async (entry) => {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
		return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [entryPath] : [];
	}));
	return nested.flat().sort();
}

function scanSourceImports(importer: string, sourceText: string, absolutePath: string): ImportEdge[] {
	const scanner = createScanner(true, LanguageVariant.Standard, sourceText);
	const edges: ImportEdge[] = [];
	const add = (specifier: string, kind: ImportKind) => {
		edges.push({
			importer,
			specifier,
			kind,
			...(specifier.startsWith(".") ? { target: resolveTarget(absolutePath, specifier) } : {}),
		});
	};
	let previous = SyntaxKind.Unknown;
	let beforePrevious = SyntaxKind.Unknown;
	let beforeBeforePrevious = SyntaxKind.Unknown;
	let declarationTypeOnly = false;
	let awaitingDeclarationModifier = false;
	let previousEnd = -1;
	for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
		if (token === SyntaxKind.ImportKeyword || token === SyntaxKind.ExportKeyword) {
			awaitingDeclarationModifier = true;
			declarationTypeOnly = false;
		} else if (awaitingDeclarationModifier) {
			declarationTypeOnly = token === SyntaxKind.TypeKeyword;
			awaitingDeclarationModifier = false;
		}
		if (token === SyntaxKind.StringLiteral) {
			if (previous === SyntaxKind.FromKeyword || previous === SyntaxKind.ImportKeyword) {
				add(scanner.getTokenValue(), declarationTypeOnly ? "type-only" : "static");
				declarationTypeOnly = false;
			} else if (previous === SyntaxKind.OpenParenToken && beforePrevious === SyntaxKind.ImportKeyword) {
				add(scanner.getTokenValue(), beforeBeforePrevious === SyntaxKind.TypeOfKeyword ? "type-only" : "dynamic");
			}
		}
		beforeBeforePrevious = beforePrevious;
		beforePrevious = previous;
		previous = token;
		const tokenEnd = scanner.getTokenEnd();
		if (tokenEnd <= previousEnd) scanner.resetTokenState(Math.min(sourceText.length, tokenEnd + 1));
		previousEnd = tokenEnd;
	}
	return edges;
}

function resolveTarget(importer: string, specifier: string): string {
	const resolved = path.resolve(path.dirname(importer), specifier);
	return relativePath(resolved.endsWith(".js") ? `${resolved.slice(0, -3)}.ts` : resolved);
}

function relativePath(filePath: string): string {
	return path.relative(REPO_ROOT, filePath).replaceAll(path.sep, "/");
}
