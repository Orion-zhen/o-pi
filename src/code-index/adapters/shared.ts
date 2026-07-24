import type { IndexedImport, LineIndex } from "../types.js";
import type { RawUnit, SyntaxNode } from "./types.js";

export interface UnitRules {
	extract(node: SyntaxNode, scope: string | undefined): RawUnit | undefined;
	childScope(node: SyntaxNode, unit: RawUnit | undefined, current: string | undefined): string | undefined;
	shouldDescend(node: SyntaxNode, unit: RawUnit): boolean;
}

export function collectUnits(root: SyntaxNode, rules: UnitRules): RawUnit[] {
	const units: RawUnit[] = [];
	walkUnits(root, undefined, rules, units);
	return units.sort(compareRawUnits);
}

function walkUnits(node: SyntaxNode, scope: string | undefined, rules: UnitRules, units: RawUnit[]): void {
	const unit = rules.extract(node, scope);
	if (unit !== undefined) units.push(unit);
	if (unit !== undefined && !rules.shouldDescend(node, unit)) return;
	const childScope = rules.childScope(node, unit, scope);
	for (const child of node.namedChildren) walkUnits(child, childScope, rules, units);
}

export function rawUnit(node: SyntaxNode, kind: string, name: string, scope?: string): RawUnit {
	const range = exportRangeNode(node);
	return {
		kind,
		name,
		qualifiedName: scope === undefined ? name : `${scope}.${name}`,
		startChar: range.startIndex,
		endChar: range.endIndex,
	};
}

export function exportRangeNode(node: SyntaxNode): SyntaxNode {
	const parent = node.parent;
	return parent?.type === "export_statement" ? parent : node;
}

export function nameField(node: SyntaxNode): string | undefined {
	return node.childForFieldName("name")?.text;
}

export function firstNamedChildText(node: SyntaxNode, types: readonly string[]): string | undefined {
	return node.namedChildren.find((child) => types.includes(child.type))?.text;
}

export function collectRegexImports(text: string, index: LineIndex, patterns: readonly RegExp[]): IndexedImport[] {
	const matches: Array<{ specifier: string; startChar: number }> = [];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			const specifier = match.groups?.["specifier"];
			const full = match[0];
			if (specifier === undefined || full === undefined || match.index === undefined) continue;
			const relativeStart = full.indexOf(specifier);
			if (relativeStart < 0) continue;
			matches.push({ specifier, startChar: match.index + relativeStart });
		}
	}
	return indexedImports(text, index, matches);
}

export function collectGoImports(text: string, index: LineIndex): IndexedImport[] {
	const matches: Array<{ specifier: string; startChar: number }> = [];
	for (const match of text.matchAll(/\bimport\s+(?:[._A-Za-z]\w*\s+)?["'](?<specifier>[^"']+)["']/gu)) {
		const specifier = match.groups?.["specifier"];
		if (specifier === undefined || match.index === undefined) continue;
		const relativeStart = match[0].indexOf(specifier);
		if (relativeStart >= 0) matches.push({ specifier, startChar: match.index + relativeStart });
	}
	for (const block of text.matchAll(/\bimport\s*\((?<body>[\s\S]*?)\)/gu)) {
		const body = block.groups?.["body"];
		if (body === undefined || block.index === undefined) continue;
		const bodyStart = block.index + block[0].indexOf(body);
		for (const match of body.matchAll(/(?:^|\n)\s*(?:[._A-Za-z]\w*\s+)?["'](?<specifier>[^"']+)["']/gu)) {
			const specifier = match.groups?.["specifier"];
			if (specifier === undefined || match.index === undefined) continue;
			const relativeStart = match[0].indexOf(specifier);
			if (relativeStart >= 0) matches.push({ specifier, startChar: bodyStart + match.index + relativeStart });
		}
	}
	return indexedImports(text, index, matches);
}

function indexedImports(text: string, index: LineIndex, matches: readonly { specifier: string; startChar: number }[]): IndexedImport[] {
	const imports: IndexedImport[] = [];
	const seen = new Set<string>();
	for (const match of matches) {
		const startByte = byteForCharWithIndex(text, index, match.startChar);
		const endByte = byteForCharWithIndex(text, index, match.startChar + match.specifier.length);
		const key = `${match.specifier}\0${startByte}\0${endByte}`;
		if (seen.has(key)) continue;
		seen.add(key);
		imports.push({
			specifier: match.specifier,
			startLine: lineForByteWithIndex(index, startByte),
			endLine: lineForByteWithIndex(index, Math.max(startByte, endByte - 1)),
			startByte,
			endByte,
		});
	}
	return imports.sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte || (left.specifier < right.specifier ? -1 : left.specifier > right.specifier ? 1 : 0));
}

export function byteForCharWithIndex(text: string, index: LineIndex, charOffset: number): number {
	let low = 0;
	let high = index.lineStartChars.length - 1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const start = index.lineStartChars[middle] ?? 0;
		if (start <= charOffset) low = middle + 1;
		else high = middle - 1;
	}
	const line = Math.max(0, high);
	const lineStartChar = index.lineStartChars[line] ?? 0;
	const lineStartByte = index.lineStarts[line] ?? 0;
	return lineStartByte + Buffer.byteLength(text.slice(lineStartChar, charOffset), "utf8");
}

export function lineForByteWithIndex(index: LineIndex, byteOffset: number): number {
	let low = 0;
	let high = index.lineStarts.length - 1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const start = index.lineStarts[middle] ?? 0;
		if (start <= byteOffset) low = middle + 1;
		else high = middle - 1;
	}
	return Math.max(1, high + 1);
}

function compareRawUnits(left: RawUnit, right: RawUnit): number {
	return left.startChar - right.startChar || left.endChar - right.endChar || left.kind.localeCompare(right.kind);
}
