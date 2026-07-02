import { fail } from "./errors.js";
import type { DiffHunk, EditOperationType, ToolOutcome } from "./types.js";

/** 解析单文件 Codex 风格 context diff；文件路径和操作类型由 JSON operation 表达。 */
export function parseContextDiff(
	diff: string,
	path: string,
	type: EditOperationType,
	operationIndex: number,
): ToolOutcome<DiffHunk[]> {
	const lines = diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	const hunks: DiffHunk[] = [];
	let current: DiffHunk | undefined;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === "@@" || line?.startsWith("@@ ")) {
			if (current) hunks.push(current);
			current = { index: hunks.length + 1, oldLines: [], newLines: [] };
			continue;
		}
		if (!current) {
			return fail("DIFF_PARSE_ERROR", "Diff must start with @@ hunk header.", {
				path,
				type,
				operation_index: operationIndex,
				details: { line: index + 1 },
			});
		}
		if (line === undefined || line.length === 0) {
			return fail("DIFF_PARSE_ERROR", "Diff hunk lines must start with space, '-' or '+'.", {
				path,
				type,
				operation_index: operationIndex,
				hunk: current.index,
				details: { line: index + 1 },
			});
		}
		const marker = line[0];
		const value = line.slice(1);
		if (marker === " ") {
			current.oldLines.push(value);
			current.newLines.push(value);
		} else if (marker === "-") {
			current.oldLines.push(value);
		} else if (marker === "+") {
			current.newLines.push(value);
		} else {
			return fail("DIFF_PARSE_ERROR", "Diff hunk lines must start with space, '-' or '+'.", {
				path,
				type,
				operation_index: operationIndex,
				hunk: current.index,
				details: { line: index + 1 },
			});
		}
	}

	if (current) hunks.push(current);
	if (hunks.length === 0) {
		return fail("DIFF_PARSE_ERROR", "Diff requires at least one hunk.", {
			path,
			type,
			operation_index: operationIndex,
		});
	}
	for (const hunk of hunks) {
		if (hunk.oldLines.length === 0) {
			return fail("DIFF_PARSE_ERROR", "Diff hunks must include old/context lines.", {
				path,
				type,
				operation_index: operationIndex,
				hunk: hunk.index,
			});
		}
	}
	return hunks;
}
