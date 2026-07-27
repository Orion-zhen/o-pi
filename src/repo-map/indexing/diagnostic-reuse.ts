import type { RepoMapDiagnostic, RepoMapFileRecord } from "../core/types.js";

/** 仅当语法诊断仍绑定到同一份已索引内容时才可复用。 */
export function isStableParserDiagnostic(
	diagnostic: RepoMapDiagnostic,
	previousFiles: ReadonlyMap<string, RepoMapFileRecord>,
	currentFiles: ReadonlyMap<string, RepoMapFileRecord>,
): boolean {
	if (diagnostic.code !== "PARSER_SYNTAX_ERROR" || diagnostic.path === undefined) return false;
	const previous = previousFiles.get(diagnostic.path);
	const current = currentFiles.get(diagnostic.path);
	return previous?.status === "indexed"
		&& current?.status === "indexed"
		&& previous.contentHash !== undefined
		&& previous.contentHash === current.contentHash;
}
