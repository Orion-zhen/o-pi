import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PI_TUI = "@earendil-works/pi-tui";

type ImportKind = "static" | "dynamic" | "type-only";

interface ImportEdge {
	importer: string;
	specifier: string;
	kind: ImportKind;
	target?: string;
}

describe("UI dependency architecture", () => {
	it("区分静态、动态和 type-only import", () => {
		const edges = scanSourceImports(
			"fixture.ts",
			[
				'import value from "./static.js";',
				'import type { Type } from "./type.js";',
				'type Lazy = typeof import("./import-type.js");',
				'const lazy = import("./dynamic.js");',
			].join("\n"),
		);
		expect(edges.map(({ specifier, kind }) => [specifier, kind])).toEqual([
			["./static.js", "static"],
			["./type.js", "type-only"],
			["./import-type.js", "type-only"],
			["./dynamic.js", "dynamic"],
		]);
	});

	it("只允许共享或 feature TUI module 运行时依赖 pi-tui", async () => {
		const edges = await repositoryImportEdges();
		const staticTargets = new Map<string, string[]>();
		const directPiTui = new Set<string>();
		for (const edge of edges) {
			if (edge.kind !== "static") continue;
			if (edge.specifier === PI_TUI) directPiTui.add(edge.importer);
			if (edge.target === undefined) continue;
			const targets = staticTargets.get(edge.importer) ?? [];
			targets.push(edge.target);
			staticTargets.set(edge.importer, targets);
		}

		const violations = new Set<string>();
		for (const importer of staticTargets.keys()) {
			if (isTuiModule(importer)) continue;
			const pathToPiTui = findPathToPiTui(importer, staticTargets, directPiTui);
			if (pathToPiTui !== undefined) violations.add(pathToPiTui.join(" -> "));
		}
		for (const importer of directPiTui) {
			if (!isTuiModule(importer)) violations.add(`${importer} -> ${PI_TUI}`);
		}
		expect([...violations].sort()).toEqual([]);
	});

	it("extension 不直接引用 pi-tui，且不静态加载 feature TUI", async () => {
		const edges = await repositoryImportEdges();
		const violations = edges.flatMap((edge) => {
			if (!edge.importer.startsWith("agent/extensions/")) return [];
			if (edge.specifier === PI_TUI) return [`direct:${edge.kind}:${edge.importer}`];
			if (edge.target !== undefined && isFeatureTuiModule(edge.target) && edge.kind === "static") {
				return [`static-feature-tui:${edge.importer}:${edge.specifier}`];
			}
			return [];
		});
		expect(violations.sort()).toEqual([]);
	});
});

async function repositoryImportEdges(): Promise<ImportEdge[]> {
	const files = [
		...(await collectTypeScriptFiles(path.join(REPO_ROOT, "src"))),
		...(await collectTypeScriptFiles(path.join(REPO_ROOT, "agent", "extensions"))),
	];
	return (await Promise.all(files.map(async (filePath) => {
		const sourceText = await readFile(filePath, "utf8");
		return scanSourceImports(relativePath(filePath), sourceText, filePath);
	}))).flat();
}

function scanSourceImports(importer: string, sourceText: string, absolutePath?: string): ImportEdge[] {
	const scanner = createScanner(true, LanguageVariant.Standard, sourceText);
	const edges: ImportEdge[] = [];
	const add = (specifier: string, kind: ImportKind) => {
		edges.push({
			importer,
			specifier,
			kind,
			...(absolutePath !== undefined && specifier.startsWith(".")
				? { target: resolveTarget(absolutePath, specifier) }
				: {}),
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

function findPathToPiTui(
	start: string,
	targetsByImporter: ReadonlyMap<string, readonly string[]>,
	directPiTui: ReadonlySet<string>,
): string[] | undefined {
	const pending: Array<{ file: string; path: string[] }> = [{ file: start, path: [start] }];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined || visited.has(current.file)) continue;
		visited.add(current.file);
		if (directPiTui.has(current.file)) return [...current.path, PI_TUI];
		for (const target of targetsByImporter.get(current.file) ?? []) {
			pending.push({ file: target, path: [...current.path, target] });
		}
	}
	return undefined;
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

function isTuiModule(filePath: string): boolean {
	return filePath.startsWith("src/tui/") || isFeatureTuiModule(filePath);
}

function isFeatureTuiModule(filePath: string): boolean {
	return /^src\/[^/]+\/tui\//u.test(filePath);
}

function resolveTarget(importer: string, specifier: string): string {
	const resolved = path.resolve(path.dirname(importer), specifier);
	const withTypeScriptExtension = resolved.endsWith(".js") ? `${resolved.slice(0, -3)}.ts` : resolved;
	return relativePath(withTypeScriptExtension);
}

function relativePath(filePath: string): string {
	return path.relative(REPO_ROOT, filePath).replaceAll(path.sep, "/");
}
