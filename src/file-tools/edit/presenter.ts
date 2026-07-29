import { escapeXmlAttribute } from "../shared/mutation-presenter.js";
import type { DiagnosticsSummary } from "../shared/diagnostics.js";
import type { EditSuccess } from "./types.js";

export function formatEditModelResult(result: EditSuccess, impact?: string): string {
	const diagnostics = editDiagnostics(result.lsp?.diagnostics);
	const attrs = [
		`path="${escapeXmlAttribute(result.path)}"`,
		`replacements="${result.replacements}"`,
	];
	if (result.firstChangedLine !== undefined) attrs.push(`first_changed_line="${result.firstChangedLine}"`);
	if (result.repo_map?.status === "partially_stale") attrs.push('repo_map="partially_stale"');
	if (diagnostics.length === 0 && impact === undefined) return `<edit ${attrs.join(" ")}/>`;
	return [
		`<edit ${attrs.join(" ")}>`,
		...diagnostics,
		...(impact === undefined ? [] : [impact]),
		"</edit>",
	].join("\n");
}

function editDiagnostics(diagnostics: DiagnosticsSummary | undefined): string[] {
	if (diagnostics === undefined) return [];
	const uncertain = diagnostics.baseline === "unknown";
	return diagnostics.items
		.filter((item) => item.severity === "error" || item.severity === "warning")
		.map((item) => {
			const prefix = uncertain ? item.severity : `new ${item.severity}`;
			const certainty = uncertain ? " (causality uncertain)" : "";
			const code = item.code === undefined ? "" : ` (${escapeXmlText(item.code)})`;
			return `${prefix} at line ${item.line}${certainty}: ${escapeXmlText(item.message)}${code}`;
		});
}

function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
