import { escapeXmlAttribute, formatMutationResult, visibleDiagnostics } from "../shared/mutation-presenter.js";
import type { WriteSuccess } from "./types.js";

export function formatWriteModelResult(result: WriteSuccess, impact?: string): string {
	const diagnostics = visibleDiagnostics(result.lsp?.diagnostics);
	const attrs = [`path="${escapeXmlAttribute(result.path)}"`];
	if (diagnostics !== undefined) attrs.push(`lsp="${escapeXmlAttribute(diagnostics.status)}"`);
	if (result.repo_map?.status === "partially_stale") attrs.push('repo_map="partially_stale"');
	return formatMutationResult("write", attrs, diagnostics, impact);
}
