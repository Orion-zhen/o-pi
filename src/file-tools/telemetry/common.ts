import { fields, isRecord, scalar, textFields } from "../../telemetry/projection.js";
import type { Fields, Resource, TelemetryFacts } from "../../telemetry/types.js";
import type { FailedResult } from "../shared/result.js";

interface FileTelemetryInput {
	path?: string | string[];
	query?: string;
	glob?: string;
	match?: string;
	lines?: string;
	pages?: string;
}

/** Project explicit scalar inputs; query-like strings are retained only as size and hash. */
export function projectFileInput<T extends FileTelemetryInput>(
	keys: readonly (keyof T & string)[],
	targetKind: string,
	options: { pathList?: boolean } = {},
): (value: T) => TelemetryFacts {
	return (value) => {
		const projected: Fields = {};
		for (const key of keys) {
			if (key === "path") continue;
			const raw = value[key];
			if (typeof raw === "string" && ["query", "glob", "match"].includes(key)) {
				Object.assign(projected, textFields(`input_${key}`, raw));
			} else {
				const item = scalar(raw);
				if (item !== undefined) projected[`input_${key}`] = item;
			}
		}
		const rawPath = value.path;
		const paths = Array.isArray(rawPath)
			? rawPath
			: rawPath === undefined
				? (options.pathList === true ? ["."] : [])
				: [rawPath];
		if (options.pathList === true) projected.input_path_count = paths.length;
		return {
			...(Object.keys(projected).length === 0 ? {} : { fields: projected }),
			...(paths.length === 0 ? {} : { targets: paths.map((path) => pathTarget(path, targetKind)) }),
		};
	};
}

export function failureFields(result: FailedResult): Fields {
	return { status: result.status, error_code: result.error.code };
}

export function failureScopeFields(result: FailedResult): Fields {
	const details = result.error.details;
	if (!isRecord(details)) return {};
	const paths = stringList(details["paths"]);
	const scopeErrors = Array.isArray(details["scope_errors"]) ? details["scope_errors"].length : undefined;
	return fields({
		scope_count: paths?.length,
		scope_error_count: scopeErrors,
	});
}

export function pathTarget(value: string, kind = "path", startLine?: number, endLine?: number): Resource {
	return {
		kind: startLine === undefined && endLine === undefined ? kind : "region",
		value,
		...(startLine === undefined ? {} : { start_line: startLine }),
		...(endLine === undefined ? {} : { end_line: endLine }),
	};
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}
