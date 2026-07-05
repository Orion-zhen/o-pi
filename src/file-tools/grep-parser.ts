import { Lang, parse, type SgNode } from "@ast-grep/napi";

export interface IndexedCodeUnit {
	id: string;
	path: string;
	language: string;
	kind: string;
	name?: string;
	qualifiedName?: string;
	signature?: string;
	startLine: number;
	endLine: number;
	startByte: number;
	endByte: number;
	tokens: Map<string, number>;
	definitions: string[];
	references: string[];
	calls: string[];
	imports: string[];
}

export interface ParsedFileIndex {
	path: string;
	language: string;
	units: IndexedCodeUnit[];
	symbols: string[];
}

interface RawUnit {
	kind: string;
	name?: string;
	qualifiedName?: string;
	startByte: number;
	endByte: number;
}

interface LineIndex {
	lineStarts: number[];
	lineStartChars: number[];
}

const IDENTIFIER = /[A-Za-z_$][\w$]*|[A-Za-z_][A-Za-z0-9_]*[-_][A-Za-z0-9_-]+|\d+/g;
const TS_DECLARATION_KINDS = new Set([
	"function_declaration",
	"method_definition",
	"class_declaration",
	"interface_declaration",
	"type_alias_declaration",
	"enum_declaration",
	"lexical_declaration",
	"variable_declaration",
]);

/** 解析单个文件的代码单元；不支持的语法安全退化为 profile 规则。 */
export function parseCodeUnits(filePath: string, text: string): ParsedFileIndex {
	const language = languageFromPath(filePath);
	const rawUnits = parseByLanguage(language, text);
	const lineIndex = buildLineIndex(text);
	const units = rawUnits.map((unit, index) => buildIndexedUnit(filePath, language, text, lineIndex, unit, index));
	return {
		path: filePath,
		language,
		units,
		symbols: units.flatMap((unit) => [unit.name, unit.qualifiedName].filter((value): value is string => value !== undefined)),
	};
}

export function languageFromPath(filePath: string): string {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".tsx")) return "tsx";
	if (lower.endsWith(".ts")) return "typescript";
	if (lower.endsWith(".jsx")) return "jsx";
	if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
	if (lower.endsWith(".py")) return "python";
	if (lower.endsWith(".go")) return "go";
	if (lower.endsWith(".rs")) return "rust";
	return "text";
}

export function tokenizeText(value: string): Map<string, number> {
	const result = new Map<string, number>();
	for (const raw of splitTokens(value)) {
		const token = raw.toLocaleLowerCase();
		if (token.length === 0) continue;
		result.set(token, (result.get(token) ?? 0) + 1);
	}
	return result;
}

export function splitTokens(value: string): string[] {
	const tokens: string[] = [];
	for (const match of value.matchAll(IDENTIFIER)) {
		const raw = match[0] ?? "";
		tokens.push(raw);
		tokens.push(...splitIdentifier(raw));
	}
	return Array.from(new Set(tokens.filter((token) => token.length > 0)));
}

export function lineForByte(text: string, byteOffset: number): number {
	const lineIndex = buildLineIndex(text);
	return lineForByteWithIndex(lineIndex, byteOffset);
}

export function byteRangeForLines(text: string, startLine: number, endLine: number): { startByte: number; endByte: number } {
	const index = buildLineIndex(text);
	const startByte = index.lineStarts[Math.max(0, startLine - 1)] ?? 0;
	const endByte = index.lineStarts[endLine] ?? Buffer.byteLength(text, "utf8");
	return { startByte, endByte };
}

export function extractByteRange(text: string, startByte: number, endByte: number): string {
	return Buffer.from(text, "utf8").subarray(startByte, endByte).toString("utf8").replace(/\s+$/u, "");
}

function parseByLanguage(language: string, text: string): RawUnit[] {
	if (language === "typescript" || language === "tsx" || language === "javascript" || language === "jsx") {
		const parsed = parseJavaScriptLike(language, text);
		if (parsed.length > 0) return parsed;
	}
	if (language === "python") return parsePython(text);
	if (language === "go") return parseGo(text);
	if (language === "rust") return parseRust(text);
	return [];
}

function parseJavaScriptLike(language: string, text: string): RawUnit[] {
	const lang = language === "tsx" || language === "jsx" ? Lang.Tsx : language === "typescript" ? Lang.TypeScript : Lang.JavaScript;
	try {
		const root = parse(lang, text).root();
		const units: RawUnit[] = [];
		collectTsUnits(root, undefined, units);
		return units.sort(compareRawUnits);
	} catch {
		return [];
	}
}

function collectTsUnits(node: SgNode, className: string | undefined, units: RawUnit[]): void {
	const kind = String(node.kind());
	const target = kind === "export_statement" ? node.children().find((child) => TS_DECLARATION_KINDS.has(String(child.kind()))) : node;
	if (target !== undefined && TS_DECLARATION_KINDS.has(String(target.kind()))) {
		const raw = rawTsUnit(target, className, kind === "export_statement" ? node : undefined);
		if (raw !== undefined) units.push(raw);
		if (raw?.kind === "class") {
			for (const child of target.children()) collectTsUnits(child, raw.name, units);
		}
		return;
	}
	if (kind === "program" || kind === "class_body") {
		for (const child of node.children()) collectTsUnits(child, className, units);
	}
}

function rawTsUnit(node: SgNode, className: string | undefined, rangeNode: SgNode | undefined = undefined): RawUnit | undefined {
	const kind = String(node.kind());
	const text = node.text();
	const range = (rangeNode ?? node).range();
	const name =
		firstChildText(node, "identifier") ??
		firstChildText(node, "type_identifier") ??
		(kind.includes("method") ? /^(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)/u.exec(text.trim())?.[1] : undefined) ??
		/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/u.exec(text.trim())?.[1];
	if (name === undefined) return undefined;
	return {
		kind: normalizeTsKind(kind),
		name,
		qualifiedName: className !== undefined && kind === "method_definition" ? `${className}.${name}` : name,
		startByte: range.start.index,
		endByte: range.end.index,
	};
}

function firstChildText(node: SgNode, kind: string): string | undefined {
	const found = node.children().find((child) => String(child.kind()) === kind);
	return found?.text();
}

function normalizeTsKind(kind: string): string {
	if (kind === "function_declaration") return "function";
	if (kind === "method_definition") return "method";
	if (kind === "class_declaration") return "class";
	if (kind === "interface_declaration") return "interface";
	if (kind === "type_alias_declaration") return "type";
	if (kind === "enum_declaration") return "enum";
	return "declaration";
}

function parsePython(text: string): RawUnit[] {
	const lines = text.split(/\n/u);
	const units: RawUnit[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const match = /^([ \t]*)(?:async\s+)?(def|class)\s+([A-Za-z_][\w]*)/u.exec(line);
		if (match !== null) {
			const indent = match[1]?.length ?? 0;
			const endLine = findIndentedBlockEnd(lines, index, indent);
			const name = match[3];
			if (name === undefined) continue;
			units.push({
				kind: match[2] === "class" ? "class" : "function",
				name,
				qualifiedName: name,
				startByte: byteOffsetForLine(lines, index),
				endByte: byteOffsetForLine(lines, endLine),
			});
		}
	}
	return units.sort(compareRawUnits);
}

function parseGo(text: string): RawUnit[] {
	return parseBraceLanguage(text, [
		{ regex: /^func\s+(?:\(([^)]+)\)\s*)?([A-Za-z_]\w*)/u, kind: "function" },
		{ regex: /^type\s+([A-Za-z_]\w*)\s+(struct|interface)/u, kind: "type" },
		{ regex: /^var\s+([A-Za-z_]\w*)/u, kind: "declaration" },
		{ regex: /^const\s+([A-Za-z_]\w*)/u, kind: "declaration" },
	]);
}

function parseRust(text: string): RawUnit[] {
	return parseBraceLanguage(text, [
		{ regex: /^(?:pub\s+)?fn\s+([A-Za-z_]\w*)/u, kind: "function" },
		{ regex: /^(?:pub\s+)?(?:struct|enum|type)\s+([A-Za-z_]\w*)/u, kind: "type" },
		{ regex: /^(?:pub\s+)?trait\s+([A-Za-z_]\w*)/u, kind: "trait" },
		{ regex: /^impl(?:\s+<[^>]+>)?\s+([A-Za-z_]\w*)?/u, kind: "module" },
	]);
}

function parseBraceLanguage(text: string, patterns: Array<{ regex: RegExp; kind: string }>): RawUnit[] {
	const lines = text.split(/\n/u);
	const units: RawUnit[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const trimmed = (lines[index] ?? "").trim();
		for (const pattern of patterns) {
			const match = pattern.regex.exec(trimmed);
			if (match === null) continue;
			const name = match[2] ?? match[1] ?? trimmed;
			const startByte = byteOffsetForLine(lines, index);
			const endLine = findBraceBlockEnd(lines, index);
			const raw: RawUnit = { kind: pattern.kind, startByte, endByte: byteOffsetForLine(lines, endLine) };
			if (name !== undefined) {
				raw.name = name;
				raw.qualifiedName = name;
			}
			units.push(raw);
			break;
		}
	}
	return units.sort(compareRawUnits);
}

function buildIndexedUnit(filePath: string, language: string, text: string, lineIndex: LineIndex, unit: RawUnit, index: number): IndexedCodeUnit {
	const content = extractByteRange(text, unit.startByte, unit.endByte);
	const signature = firstNonEmptyLine(content);
	const nameText = [filePath, unit.name, unit.qualifiedName, signature, content].join("\n");
	const tokens = tokenizeText(nameText);
	const references = Array.from(new Set(splitTokens(content))).filter((token) => !/^\d+$/u.test(token));
	const calls = Array.from(content.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/gu), (match) => match[1] ?? "").filter(Boolean);
	const imports = Array.from(content.matchAll(/\b(?:from|import|require)\s*(?:\(\s*)?["']([^"']+)["']/gu), (match) => match[1] ?? "").filter(Boolean);
	return {
		id: `${filePath}:${unit.startByte}:${unit.endByte}:${index}`,
		path: filePath,
		language,
		kind: unit.kind,
		...(unit.name !== undefined ? { name: unit.name } : {}),
		...(unit.qualifiedName !== undefined ? { qualifiedName: unit.qualifiedName } : {}),
		...(signature !== undefined ? { signature } : {}),
		startLine: lineForByteWithIndex(lineIndex, unit.startByte),
		endLine: lineForByteWithIndex(lineIndex, Math.max(unit.startByte, unit.endByte - 1)),
		startByte: unit.startByte,
		endByte: unit.endByte,
		tokens,
		definitions: unit.name === undefined ? [] : [unit.name],
		references,
		calls,
		imports,
	};
}

function firstNonEmptyLine(text: string): string | undefined {
	return text.split(/\n/u).find((line) => line.trim().length > 0)?.trim();
}

function buildLineIndex(text: string): LineIndex {
	const lineStarts = [0];
	const lineStartChars = [0];
	let bytes = 0;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index] ?? "";
		bytes += Buffer.byteLength(char, "utf8");
		if (char === "\n") {
			lineStarts.push(bytes);
			lineStartChars.push(index + 1);
		}
	}
	return { lineStarts, lineStartChars };
}

function lineForByteWithIndex(index: LineIndex, byteOffset: number): number {
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

function byteOffsetForLine(lines: string[], lineIndex: number): number {
	let offset = 0;
	for (let index = 0; index < lineIndex && index < lines.length; index += 1) {
		offset += Buffer.byteLength(lines[index] ?? "", "utf8") + 1;
	}
	return offset;
}

function findIndentedBlockEnd(lines: string[], start: number, indent: number): number {
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim().length === 0) continue;
		const current = /^\s*/u.exec(line)?.[0].length ?? 0;
		if (current <= indent) return index;
	}
	return lines.length;
}

function findBraceBlockEnd(lines: string[], start: number): number {
	let depth = 0;
	let opened = false;
	for (let index = start; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		for (const char of line) {
			if (char === "{") {
				depth += 1;
				opened = true;
			} else if (char === "}") {
				depth -= 1;
			}
		}
		if (opened && depth <= 0) return index + 1;
		if (!opened && index > start) return index;
	}
	return lines.length;
}

function splitIdentifier(value: string): string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
		.split(/[^A-Za-z0-9]+/u)
		.filter(Boolean);
}

function compareRawUnits(left: RawUnit, right: RawUnit): number {
	return left.startByte - right.startByte || left.endByte - right.endByte || left.kind.localeCompare(right.kind);
}
