import type {
	ReadEnclosingSymbol,
	ReadGraphContext,
	ReadRemainingSymbol,
	ReadStructureContext,
	ReadSuccess,
} from "./types.js";

/** Compact model-visible text for a successful UTF-8 read. */
export function formatReadModelResult(result: ReadSuccess, graphContext: string | undefined = undefined): string {
	const attrs = [
		`path="${escapeXmlAttribute(result.path)}"`,
		`lines="${result.start_line}-${result.end_line}/${result.total_lines}"`,
	];
	if (result.continuation !== undefined) attrs.push(`more="${result.continuation.start_line}"`);
	else if (result.truncated) attrs.push('truncated="true"');
	if (result.ignored) attrs.push(`ignored="${escapeXmlAttribute(result.ignore_source ?? "true")}"`);
	if (result.bom) attrs.push('bom="true"');
	if (result.newline !== "lf") attrs.push(`newline="${result.newline}"`);

	const structure = formatReadStructureContext(result.lsp, result.repo_map);
	let text = `<read ${attrs.join(" ")}>\n${result.content}`;
	if (!text.endsWith("\n")) text += "\n";
	if (structure !== undefined) text += `${structure}\n`;
	if (graphContext !== undefined) text += `${graphContext}\n`;
	return `${text}</read>`;
}

export function formatReadStructureContext(
	structure: ReadStructureContext | undefined,
	graph: ReadGraphContext | undefined,
): string | undefined {
	if (structure === undefined) return undefined;
	const attrs: string[] = [];
	if (structure.enclosing_symbol !== undefined && !sameSymbol(structure.enclosing_symbol, graph)) {
		attrs.push(`enclosing="${escapeXmlAttribute(formatSymbolRange(structure.enclosing_symbol))}"`);
	}
	const sections: string[] = [];
	if (attrs.length > 0) sections.push(`<lsp ${attrs.join(" ")}/>`);
	if (structure.remaining_symbols !== undefined && structure.remaining_symbols.length > 0) {
		sections.push(`<remaining_symbols>\n${structure.remaining_symbols.map(formatRemainingSymbol).join("\n")}\n</remaining_symbols>`);
	}
	return sections.length === 0 ? undefined : sections.join("\n");
}

function sameSymbol(enclosing: ReadEnclosingSymbol, graph: ReadGraphContext | undefined): boolean {
	if (graph === undefined
		|| enclosing.kind !== graph.symbol.kind
		|| enclosing.line !== graph.symbol.startLine
		|| enclosing.end_line !== graph.symbol.endLine) return false;
	const graphName = graph.symbol.qualifiedName ?? graph.symbol.name;
	return graphName === enclosing.name || graphName?.endsWith(`.${enclosing.name}`) === true;
}

function formatRemainingSymbol(item: ReadRemainingSymbol): string {
	return `line ${item.line}-${item.end_line}: ${escapeXmlText(`${item.kind} ${item.name}`)}`;
}

function formatSymbolRange(item: ReadEnclosingSymbol): string {
	return `${item.kind} ${item.name} ${item.line}-${item.end_line}`;
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
