import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
	EditSuccess,
	FailedResult,
	LspDiagnosticsSummary,
	LspEnclosingSymbol,
	LspOutlineItem,
	ReadImageSuccess,
	ReadSuccess,
	WriteSuccess,
} from "../types.js";

/** 文件工具失败的模型可见结果；完整错误结构保留在 details。 */
export function formatErrorModelResult(tool: string, result: FailedResult): string {
	const next = result.error.next !== undefined ? `\nnext: ${escapeXmlText(result.error.next)}` : "";
	return `<error tool="${escapeXmlAttribute(tool)}" code="${escapeXmlAttribute(result.error.code)}">
${escapeXmlText(result.error.message)}${next}
</error>`;
}

/** read 的模型可见成功结果：默认字段留在 details，只输出定位、正文和非默认状态。 */
export function formatReadModelResult(result: ReadSuccess, repoMap: string | undefined = undefined): string {
	const attrs = [
		`path="${escapeXmlAttribute(result.path)}"`,
		`lines="${result.start_line}-${result.end_line}/${result.total_lines}"`,
	];
	if (result.continuation !== undefined) attrs.push(`more="${result.continuation.start_line}"`);
	else if (result.truncated) attrs.push(`truncated="true"`);
	if (result.ignored) attrs.push(`ignored="${escapeXmlAttribute(result.ignore_source ?? "true")}"`);
	if (result.bom) attrs.push(`bom="true"`);
	if (result.newline !== "lf") attrs.push(`newline="${result.newline}"`);

	const lsp = formatReadLsp(result.lsp, result.repo_map);
	let text = `<read ${attrs.join(" ")}>\n${result.content}`;
	if (!text.endsWith("\n")) text += "\n";
	if (lsp !== undefined) text += `${lsp}\n`;
	if (repoMap !== undefined) text += `${repoMap}\n`;
	return `${text}</read>`;
}

export function formatReadImageModelContent(result: ReadImageSuccess, model: { input?: readonly string[] } | undefined): Array<TextContent | ImageContent> {
	const note = [result.content, getNonVisionImageNote(model)].filter((part): part is string => part !== undefined).join("\n");
	return [
		{ type: "text", text: note },
		{ type: "image", data: result.image.data, mimeType: result.image.mime_type },
	];
}

/** edit 的模型可见成功结果确认写入事实，并附加有限 LSP 诊断；完整结构保留在 details。 */
export function formatEditModelResult(result: EditSuccess, impact: string | undefined = undefined): string {
	const diagnostics = visibleDiagnostics(result.lsp?.diagnostics);
	const attrs = [
		`path="${escapeXmlAttribute(result.path)}"`,
		`replacements="${result.replacements}"`,
	];
	if (result.firstChangedLine !== undefined) attrs.push(`first_changed_line="${result.firstChangedLine}"`);
	if (diagnostics !== undefined) attrs.push(`lsp="${escapeXmlAttribute(diagnostics.status)}"`);
	if (result.repo_map?.status === "partially_stale") attrs.push('repo_map="partially_stale"');
	return formatMutationModelResult("edit", attrs, diagnostics, impact);
}

export function formatWriteModelResult(result: WriteSuccess, impact: string | undefined = undefined): string {
	const diagnostics = visibleDiagnostics(result.lsp?.diagnostics);
	const attrs = [`path="${escapeXmlAttribute(result.path)}"`];
	if (diagnostics !== undefined) attrs.push(`lsp="${escapeXmlAttribute(diagnostics.status)}"`);
	if (result.repo_map?.status === "partially_stale") attrs.push('repo_map="partially_stale"');
	return formatMutationModelResult("write", attrs, diagnostics, impact);
}

function formatMutationModelResult(
	tool: "edit" | "write",
	attrs: string[],
	diagnostics: LspDiagnosticsSummary | undefined,
	impact: string | undefined,
): string {
	if (diagnostics === undefined) {
		return impact === undefined ? `<${tool} ${attrs.join(" ")}/>` : `<${tool} ${attrs.join(" ")}>
${impact}
</${tool}>`;
	}

	const lines = [
		`<${tool} ${attrs.join(" ")}>`,
		`errors=${diagnostics.file_errors} warnings=${diagnostics.file_warnings} new_errors=${diagnostics.new_errors} new_warnings=${diagnostics.new_warnings}`,
		...formatDiagnosticItems(diagnostics.items, diagnostics.total_items),
		...(impact === undefined ? [] : [impact]),
		`</${tool}>`,
	];
	return lines.join("\n");
}

export function scrubVersions(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(scrubVersions);
	if (value === null || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (key === "version" || key === "old_version" || key === "new_version" || key === "expected" || key === "actual") continue;
		result[key] = scrubVersions(item);
	}
	return result;
}

function getNonVisionImageNote(model: { input?: readonly string[] } | undefined): string | undefined {
	if (model === undefined || model.input?.includes("image")) return undefined;
	return "[Current model does not support images. The image may be omitted by the provider.]";
}

function visibleDiagnostics(diagnostics: LspDiagnosticsSummary | undefined): LspDiagnosticsSummary | undefined {
	return diagnostics?.status === "errors" || diagnostics?.status === "warnings" ? diagnostics : undefined;
}

function formatDiagnosticItems(items: LspDiagnosticsSummary["items"], totalItems: number): string[] {
	const visible = items.map((item) => {
		const code = item.code !== undefined ? ` (${item.code})` : "";
		return `diag ${item.severity} ${item.line}:${item.column} ${escapeXmlText(item.message)}${escapeXmlText(code)}`;
	});
	const remaining = Math.max(0, totalItems - items.length);
	if (remaining > 0) visible.push(`... ${remaining} more diagnostics`);
	return visible;
}

function formatReadLsp(lsp: ReadSuccess["lsp"], repoMap: ReadSuccess["repo_map"]): string | undefined {
	if (lsp === undefined) return undefined;
	const attrs: string[] = [];
	if (lsp.enclosing_symbol !== undefined && !sameSymbol(lsp.enclosing_symbol, repoMap)) {
		attrs.push(`enclosing="${escapeXmlAttribute(formatSymbolRange(lsp.enclosing_symbol))}"`);
	}
	if (lsp.outline !== undefined && lsp.outline.length > 0) attrs.push(`outline="${escapeXmlAttribute(lsp.outline.map(formatOutlineItem).join("; "))}"`);
	return attrs.length === 0 ? undefined : `<lsp ${attrs.join(" ")}/>`;
}

function sameSymbol(enclosing: LspEnclosingSymbol, repoMap: ReadSuccess["repo_map"]): boolean {
	if (repoMap === undefined
		|| enclosing.kind !== repoMap.symbol.kind
		|| enclosing.line !== repoMap.symbol.startLine
		|| enclosing.end_line !== repoMap.symbol.endLine) return false;
	const repoName = repoMap.symbol.qualifiedName ?? repoMap.symbol.name;
	return repoName === enclosing.name || repoName?.endsWith(`.${enclosing.name}`) === true;
}

function formatOutlineItem(item: LspOutlineItem): string {
	const current = formatSymbolRange(item);
	if (item.children === undefined || item.children.length === 0) return current;
	return `${current} > ${item.children.map(formatOutlineItem).join(", ")}`;
}

function formatSymbolRange(item: LspOutlineItem | LspEnclosingSymbol): string {
	return `${item.kind} ${item.name} ${item.line}-${item.end_line}`;
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
