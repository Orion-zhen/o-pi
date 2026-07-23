import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import type { CallRecord, Candidate, Fields, Resource, RunRecord, TelemetryRecord } from "../telemetry/types.js";

const MAX_JSONL_LINE_CHARS = 1_000_000;
const RUN_REASONS = new Set<RunRecord["reason"]>(["startup", "reload", "new", "resume", "fork"]);

export interface TelemetryFileReadResult {
	records: TelemetryRecord[];
	invalid_lines: number;
}

export interface TelemetryDirectoryReadResult extends TelemetryFileReadResult {
	files: string[];
}

export async function readTelemetryJsonl(file: string): Promise<TelemetryFileReadResult> {
	try {
		if (!(await stat(file)).isFile()) return { records: [], invalid_lines: 0 };
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { records: [], invalid_lines: 0 };
		throw error;
	}
	const records: TelemetryRecord[] = [];
	let invalidLines = 0;
	const input = createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of lines) {
			if (line.trim().length === 0) continue;
			if (line.length > MAX_JSONL_LINE_CHARS) {
				invalidLines += 1;
				continue;
			}
			try {
				const value: unknown = JSON.parse(line);
				if (isTelemetryRecord(value)) records.push(value);
				else invalidLines += 1;
			} catch {
				invalidLines += 1;
			}
		}
	} finally {
		lines.close();
		input.destroy();
	}
	return { records, invalid_lines: invalidLines };
}

export async function readTelemetryDirectory(directory = path.join(os.homedir(), ".pi", "telemetry", "runs")): Promise<TelemetryDirectoryReadResult> {
	let files: string[];
	try {
		files = (await readdir(directory, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => path.join(directory, entry.name))
			.sort();
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { records: [], invalid_lines: 0, files: [] };
		throw error;
	}
	const records: TelemetryRecord[] = [];
	let invalidLines = 0;
	for (const file of files) {
		const result = await readTelemetryJsonl(file);
		records.push(...result.records);
		invalidLines += result.invalid_lines;
	}
	return { records, invalid_lines: invalidLines, files };
}

export function isTelemetryRecord(value: unknown): value is TelemetryRecord {
	if (!isRecord(value) || !text(value["run_id"]) || !timestamp(value["at"])) return false;
	return value["type"] === "run" ? runRecord(value) : value["type"] === "call" && callRecord(value);
}

function runRecord(value: Record<string, unknown>): value is Record<string, unknown> & RunRecord {
	return text(value["session_id"]) && RUN_REASONS.has(value["reason"] as RunRecord["reason"]) && text(value["cwd"])
		&& (value["git"] === undefined || gitRevision(value["git"]));
}

function callRecord(value: Record<string, unknown>): value is Record<string, unknown> & CallRecord {
	return text(value["call_id"]) && nonNegativeInteger(value["call_index"]) && optionalNonNegativeInteger(value["turn_index"])
		&& text(value["tool"]) && optionalText(value["definition_hash"])
		&& timestamp(value["started_at"]) && timestamp(value["ended_at"]) && nonNegativeNumber(value["duration_ms"])
		&& (value["status"] === "success" || value["status"] === "error")
		&& optionalNonNegativeNumber(value["output_chars"]) && optionalNonNegativeNumber(value["output_lines"])
		&& (value["truncated"] === undefined || typeof value["truncated"] === "boolean")
		&& (value["fields"] === undefined || telemetryFields(value["fields"]))
		&& (value["targets"] === undefined || resources(value["targets"]))
		&& (value["candidates"] === undefined || candidates(value["candidates"]))
		&& (value["batch"] === undefined || batch(value["batch"]))
		&& (value["repair"] === undefined || repair(value["repair"]));
}

function gitRevision(value: unknown): boolean {
	return isRecord(value) && optionalText(value["root"]) && optionalText(value["commit"])
		&& typeof value["dirty"] === "boolean" && optionalText(value["dirty_diff_hash"]);
}

function telemetryFields(value: unknown): value is Fields {
	return isRecord(value) && Object.values(value).every((item) => item === null || typeof item === "string"
		|| typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))
		|| (Array.isArray(item) && item.every((entry) => typeof entry === "string")));
}

function resources(value: unknown): value is Resource[] {
	return Array.isArray(value) && value.every(resource);
}

function candidates(value: unknown): value is Candidate[] {
	return Array.isArray(value) && value.every((item) => resource(item) && isRecord(item)
		&& positiveInteger(item["rank"]) && (item["group"] === undefined || text(item["group"]))
		&& Array.isArray(item["sources"]) && item["sources"].every(text));
}

function resource(value: unknown): boolean {
	return isRecord(value) && text(value["kind"]) && text(value["value"])
		&& optionalPositiveInteger(value["start_line"]) && optionalPositiveInteger(value["end_line"]);
}

function batch(value: unknown): boolean {
	return isRecord(value) && text(value["id"]) && positiveInteger(value["size"])
		&& nonNegativeInteger(value["index"]) && value["index"] < value["size"];
}

function repair(value: unknown): boolean {
	return isRecord(value) && ["accepted", "repaired", "invalid"].includes(String(value["status"]))
		&& Array.isArray(value["operations"]) && value["operations"].every(text)
		&& (value["fanout"] === undefined || fanout(value["fanout"]));
}

function fanout(value: unknown): boolean {
	return isRecord(value)
		&& text(value["field"])
		&& positiveInteger(value["count"])
		&& ["scalar", "comma", "whitespace", "newline", "mixed"].includes(String(value["separator"]));
}

function timestamp(value: unknown): boolean {
	return text(value) && Number.isFinite(Date.parse(value));
}

function text(value: unknown): value is string {
	return typeof value === "string";
}

function optionalText(value: unknown): boolean {
	return value === undefined || text(value);
}

function nonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalNonNegativeNumber(value: unknown): boolean {
	return value === undefined || nonNegativeNumber(value);
}

function nonNegativeInteger(value: unknown): value is number {
	return Number.isInteger(value) && nonNegativeNumber(value);
}

function optionalNonNegativeInteger(value: unknown): boolean {
	return value === undefined || nonNegativeInteger(value);
}

function positiveInteger(value: unknown): value is number {
	return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function optionalPositiveInteger(value: unknown): boolean {
	return value === undefined || positiveInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error && "code" in value;
}
