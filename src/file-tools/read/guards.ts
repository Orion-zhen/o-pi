import type { ReadFileSuccess, ReadImageSuccess, ReadSuccess } from "./types.js";

export function isReadFileSuccess(value: unknown): value is ReadFileSuccess {
	return isReadSuccess(value) || isReadImageSuccess(value);
}

export function isReadSuccess(value: unknown): value is ReadSuccess {
	return isPlainRecord(value)
		&& typeof value["path"] === "string"
		&& typeof value["content"] === "string"
		&& typeof value["start_line"] === "number"
		&& typeof value["end_line"] === "number"
		&& typeof value["total_lines"] === "number";
}

export function isReadImageSuccess(value: unknown): value is ReadImageSuccess {
	if (!isPlainRecord(value) || value["media_type"] !== "image" || typeof value["path"] !== "string" || typeof value["content"] !== "string") {
		return false;
	}
	const image = value["image"];
	return isPlainRecord(image) && typeof image["data"] === "string" && typeof image["mime_type"] === "string";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
