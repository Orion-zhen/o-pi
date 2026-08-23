import { fields, isRecord } from "../../telemetry/projection.js";
import type { Fields } from "../../telemetry/types.js";

export function webResultFields(details: Record<string, unknown>): Fields {
	const attempts = Array.isArray(details["attempts"]) ? details["attempts"] : undefined;
	const range = record(details["range"]);
	return fields({
		status: string(details["status"]),
		error_code: string(record(details["error"])["code"]) ?? string(details["error_code"]),
		provider: string(details["provider"]),
		http_status: number(details["http_status"]),
		attempt_count: attempts?.length,
		fallback: attempts === undefined ? undefined : attempts.length > 1,
		truncated: boolean(range["has_more"]),
		format: string(details["format"]),
		total_chars: number(details["total_chars"]),
	});
}

export function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

export function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}
