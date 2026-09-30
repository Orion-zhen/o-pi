import { Type, type Static } from "typebox";
import type { FindDetails } from "../find/types.ts";
import type { GrepSuccess } from "../grep/types.ts";

const scopeErrors = Type.Optional(Type.Array(Type.Object({ path: Type.String(), code: Type.String() })));

export const findOutputSchema = Type.Object({
	matches: Type.Array(Type.Object({ path: Type.String(), kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]) })),
	total_matches: Type.Integer(),
	truncated: Type.Boolean(),
	scope_errors: scopeErrors,
});

export const grepOutputSchema = Type.Object({
	regions: Type.Array(Type.Object({
		path: Type.String(), start_line: Type.Integer(), end_line: Type.Integer(),
		symbol: Type.Optional(Type.String()),
		lines: Type.Array(Type.Object({ line: Type.Integer(), text: Type.String() })),
	})),
	truncated: Type.Boolean(),
	scope_errors: scopeErrors,
});

/** 脚本只接收已选中的证据，不暴露排序诊断和内部扫描状态。 */
export function findStructuredOutput(details: FindDetails): Static<typeof findOutputSchema> {
	return {
		matches: details.matches.map(({ path, kind }) => ({ path, kind })),
		total_matches: details.total_matches,
		truncated: details.truncated_by.some((reason) => reason !== "output_limit"),
		...(details.scope_errors?.length ? { scope_errors: details.scope_errors.map(({ path, error }) => ({ path, code: error.code })) } : {}),
	};
}

export function grepStructuredOutput(details: GrepSuccess): Static<typeof grepOutputSchema> {
	return {
		regions: details.regions.map((region) => ({
			path: region.path, start_line: region.start_line, end_line: region.end_line,
			...(region.symbol === undefined ? {} : { symbol: region.symbol }),
			lines: (region.display_lines ?? []).map(({ line, text }) => ({ line, text })),
		})),
		truncated: details.truncated_by.length > 0,
		...(details.scope_errors?.length ? { scope_errors: details.scope_errors.map(({ path, error }) => ({ path, code: error.code })) } : {}),
	};
}
