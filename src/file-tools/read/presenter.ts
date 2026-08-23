import type {
	ReadEnclosingSymbol,
	ReadPdfPage,
	ReadPdfSuccess,
	ReadRemainingSymbol,
	ReadStructureContext,
	ReadSuccess,
} from "./types.js";

const PDF_METADATA_FIELD_CODE_POINTS = 256;
const PDF_PAGE_LABEL_CODE_POINTS = 128;
const PDF_PAGE_HINTS_CODE_POINTS = 512;

/** Compact model-visible text for a successful UTF-8 read. */
export function formatReadModelResult(result: ReadSuccess): string {
	const attrs = [
		`path="${escapeXmlAttribute(result.path)}"`,
		`lines="${result.start_line}-${result.end_line}/${result.total_lines}"`,
	];
	if (result.continuation !== undefined) attrs.push(`more="${result.continuation.start_line}"`);
	else if (result.truncated) attrs.push('truncated="true"');
	if (result.ignored) attrs.push(`ignored="${escapeXmlAttribute(result.ignore_source ?? "true")}"`);
	if (result.bom) attrs.push('bom="true"');
	if (result.newline !== "lf") attrs.push(`newline="${result.newline}"`);

	const structure = formatReadStructureContext(result.lsp);
	let text = `<read ${attrs.join(" ")}>\n${result.content}`;
	if (!text.endsWith("\n")) text += "\n";
	if (structure !== undefined) text += `${structure}\n`;
	return `${text}</read>`;
}

/** Bounded model-visible summary for a rendered PDF. */
export function formatReadPdfModelSummary(result: ReadPdfSuccess): string {
	const attrs = [
		`path="${escapeXmlAttribute(cleanXml(result.path))}"`,
		`pages="${result.start_page}-${result.end_page}/${result.total_pages}"`,
	];
	if (result.continuation !== undefined) attrs.push(`more="${result.continuation.start_page}"`);
	if (result.ignore_source !== undefined) attrs.push(`ignored="${escapeXmlAttribute(cleanXml(result.ignore_source))}"`);

	for (const [key, raw] of [["title", result.metadata.title], ["author", result.metadata.author]] as const) {
		if (raw === undefined) continue;
		const value = truncateCodePoints(cleanXml(raw), PDF_METADATA_FIELD_CODE_POINTS);
		if (value.length > 0) attrs.push(`${key}="${escapeXmlAttribute(value)}"`);
	}

	return `<pdf ${attrs.join(" ")}/>`;
}

/** Physical page marker emitted immediately before its image. */
export function formatReadPdfPageMarker(page: ReadPdfPage): string {
	const attrs = [`number="${page.number}"`];
	const physicalLabel = String(page.number);
	if (page.label !== undefined && page.label !== physicalLabel) {
		const label = truncateCodePoints(cleanXml(page.label), PDF_PAGE_LABEL_CODE_POINTS);
		if (label.length > 0) attrs.push(`label="${escapeXmlAttribute(label)}"`);
	}
	const hints = truncateCodePoints(
		cleanXml(page.hints?.join("\n") ?? ""),
		PDF_PAGE_HINTS_CODE_POINTS,
	);
	if (hints.length === 0) return `<pdf_page ${attrs.join(" ")}/>`;
	return `<pdf_page ${attrs.join(" ")}>\n${escapeXmlText(hints)}\n</pdf_page>`;
}

export function formatReadStructureContext(structure: ReadStructureContext | undefined): string | undefined {
	if (structure === undefined) return undefined;
	const attrs: string[] = [];
	if (structure.enclosing_symbol !== undefined) {
		attrs.push(`enclosing="${escapeXmlAttribute(formatSymbolRange(structure.enclosing_symbol))}"`);
	}
	const sections: string[] = [];
	if (attrs.length > 0) sections.push(`<lsp ${attrs.join(" ")}/>`);
	if (structure.remaining_symbols !== undefined && structure.remaining_symbols.length > 0) {
		sections.push(`<remaining_symbols>\n${structure.remaining_symbols.map(formatRemainingSymbol).join("\n")}\n</remaining_symbols>`);
	}
	return sections.length === 0 ? undefined : sections.join("\n");
}

function formatRemainingSymbol(item: ReadRemainingSymbol): string {
	return `line ${item.line}-${item.end_line}: ${escapeXmlText(`${item.kind} ${item.name}`)}`;
}

function formatSymbolRange(item: ReadEnclosingSymbol): string {
	return `${item.kind} ${item.name} ${item.line}-${item.end_line}`;
}

function cleanXml(value: string): string {
	return value.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "");
}

function truncateCodePoints(value: string, limit: number): string {
	const codePoints = Array.from(value);
	return codePoints.length <= limit ? value : codePoints.slice(0, limit).join("");
}

function escapeXmlText(value: string): string {
	return value
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;");
}

function escapeXmlAttribute(value: string): string {
	return escapeXmlText(value).replace(/"/gu, "&quot;");
}
