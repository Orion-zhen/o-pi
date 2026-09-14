import os from "node:os";
import path from "node:path";

import type { TelemetryReport, TelemetryReportQuery } from "./types.js";

export interface GenerateTelemetryReportOptions {
	inputDirectory?: string;
	outputDirectory?: string;
	generatedAt?: string;
	query?: TelemetryReportQuery;
}

export interface GenerateTelemetryReportResult {
	report: TelemetryReport;
	output_directory: string;
}

export async function generateTelemetryReport(options: GenerateTelemetryReportOptions = {}): Promise<GenerateTelemetryReportResult> {
	const usesDefaultInput = options.inputDirectory === undefined;
	const inputDirectory = path.resolve(options.inputDirectory ?? path.join(os.homedir(), ".pi", "telemetry", "runs"));
	const outputDirectory = path.resolve(options.outputDirectory ?? path.join(os.homedir(), ".pi", "telemetry", "reports", "latest"));
	const [{ mkdir, stat, writeFile }, { readTelemetryDirectory }, { aggregateTelemetry }, { renderTelemetryHtml }] = await Promise.all([
		import("node:fs/promises"),
		import("./read.js"),
		import("./aggregate.js"),
		import("./html.js"),
	]);
	let defaultInputMissing = false;
	if (usesDefaultInput) {
		try {
			await stat(inputDirectory);
		} catch (error) {
			if (!isMissingPath(error)) throw error;
			defaultInputMissing = true;
		}
	}
	const input = defaultInputMissing
		? { records: [], invalid_lines: 0, files: [] }
		: await readTelemetryDirectory(inputDirectory);
	const report = aggregateTelemetry(input.records, {
		generatedAt: normalizeTimestamp(options.generatedAt),
		query: options.query ?? {},
		inputFiles: input.files.map((file) => path.relative(inputDirectory, file).replace(/\\/gu, "/")),
		invalidLines: input.invalid_lines,
	});
	await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
	await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await writeFile(path.join(outputDirectory, "report.html"), renderTelemetryHtml(report), { encoding: "utf8", mode: 0o600 });
	return { report, output_directory: outputDirectory };
}

function normalizeTimestamp(value: string | undefined): string {
	if (value === undefined) return new Date().toISOString();
	const timestamp = new Date(value);
	if (!Number.isFinite(timestamp.getTime())) throw new Error("generatedAt must be a valid timestamp.");
	return timestamp.toISOString();
}

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
