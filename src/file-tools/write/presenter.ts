import { escapeXmlAttribute, formatMutationResult, visibleDiagnostics } from "../shared/mutation-presenter.js";
import type { WriteSuccess } from "./types.js";

export function formatWriteModelResult(result: WriteSuccess): string {
	const diagnostics = visibleDiagnostics(result.lsp?.diagnostics);
	const attrs = [`path="${escapeXmlAttribute(result.path)}"`];
	if (diagnostics !== undefined) attrs.push(`lsp="${(diagnostics.related?.length ?? 0) > 0 ? "errors" : escapeXmlAttribute(diagnostics.status)}"`);
	return formatMutationResult("write", attrs, diagnostics);
}
