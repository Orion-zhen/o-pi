import type { LsEntry, LsSuccess } from "./types.js";

/** Formats the model-visible compact shell-style result; full structure remains in details. */
export function formatCompactLsResult(result: LsSuccess): string {
	const header = result.truncated
		? `${result.path} ${result.returned_entries}/${result.total_entries} truncated`
		: `${result.path} ${result.entries.length}`;
	const lines = [header, ...result.entries.map(formatCompactEntry)];
	if (result.truncated) lines.push("[narrow path]");
	return lines.join("\n");
}

function formatCompactEntry(entry: LsEntry): string {
	const name = escapeLineText(entry.name);
	const ignored = entry.ignored === true ? ` !${entry.ignore_source ?? "ignored"}` : "";
	if (entry.type === "directory") return `${name}/${ignored}`;
	if (entry.type === "symlink") {
		const target = entry.link_target === undefined ? "" : ` -> ${escapeLineText(entry.link_target)}`;
		return `${name}@${target}${ignored}`;
	}
	if (entry.type === "other") return `${name}?${ignored}`;
	return `${name}${ignored}`;
}

function escapeLineText(value: string): string {
	return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}
