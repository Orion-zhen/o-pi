import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const worker = fileURLToPath(new URL("../../scripts/bench-repo-map-worker.mjs", import.meta.url));

interface BenchmarkResult {
	readonly size: number;
	readonly generation: string;
	readonly oracleDigest: string;
	readonly counts: {
		readonly files: number;
		readonly symbols: number;
		readonly tests: number;
		readonly edges: number;
		readonly aliases: number;
	};
}

describe("Repo Map performance benchmark", () => {
	it("keeps the deterministic fixture generation and semantic oracle stable", async () => {
		const first = await runWorker();
		const second = await runWorker();

		expect(second.generation).toBe(first.generation);
		expect(second.oracleDigest).toBe(first.oracleDigest);
		expect(first).toMatchObject({
			size: 4,
			oracleDigest: "8761714dae4945145d2950ac4185090cc83100cb995ad5f2d66a200c7de22159",
			counts: { files: 5, symbols: 6, tests: 0, edges: 50, aliases: 33 },
		});
	}, 10_000);
});

async function runWorker(): Promise<BenchmarkResult> {
	const { stdout } = await execFileAsync(process.execPath, [worker, "--size=4"], {
		cwd: fileURLToPath(new URL("../..", import.meta.url)),
	});
	return parseResult(stdout);
}

function parseResult(output: string): BenchmarkResult {
	const value: unknown = JSON.parse(output);
	if (!isRecord(value) || typeof value["size"] !== "number" || typeof value["generation"] !== "string"
		|| typeof value["oracleDigest"] !== "string" || !isRecord(value["counts"])) {
		throw new Error("Repo Map benchmark worker returned an invalid result");
	}
	const counts = value["counts"];
	return {
		size: value["size"],
		generation: value["generation"],
		oracleDigest: value["oracleDigest"],
		counts: {
			files: readNumber(counts, "files"),
			symbols: readNumber(counts, "symbols"),
			tests: readNumber(counts, "tests"),
			edges: readNumber(counts, "edges"),
			aliases: readNumber(counts, "aliases"),
		},
	};
}

function readNumber(value: Record<string, unknown>, key: string): number {
	const result = value[key];
	if (typeof result !== "number") throw new Error(`Repo Map benchmark worker omitted count: ${key}`);
	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
