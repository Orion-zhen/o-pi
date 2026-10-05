import { escapeXmlAttribute, formatMutationResult, visibleDiagnostics } from "../shared/mutation-presenter.ts";
import type { WriteSuccess } from "./types.ts";

export function formatWriteModelResult(result: WriteSuccess): string {
	const diagnostics = visibleDiagnostics(result.lsp?.diagnostics);
	const attrs = [`path="${escapeXmlAttribute(result.path)}"`];
	return formatMutationResult("write", attrs, diagnostics);
}
