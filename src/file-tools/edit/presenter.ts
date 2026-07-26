import { escapeXmlAttribute, formatMutationResult, visibleDiagnostics } from "../shared/mutation-presenter.js";
import type { EditSuccess } from "./types.js";

export function formatEditModelResult(result: EditSuccess, impact?: string): string {
	const diagnostics = visibleDiagnostics(result.lsp?.diagnostics);
	const attrs = [
		`path="${escapeXmlAttribute(result.path)}"`,
		`replacements="${result.replacements}"`,
	];
	if (result.firstChangedLine !== undefined) attrs.push(`first_changed_line="${result.firstChangedLine}"`);
	if (diagnostics !== undefined) attrs.push(`lsp="${escapeXmlAttribute(diagnostics.status)}"`);
	if (result.repo_map?.status === "partially_stale") attrs.push('repo_map="partially_stale"');
	return formatMutationResult("edit", attrs, diagnostics, impact);
}
