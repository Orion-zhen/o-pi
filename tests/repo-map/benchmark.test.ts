import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const worker = fileURLToPath(new URL("../../scripts/workers/bench-repo-map-worker.mjs", import.meta.url));

interface BenchmarkResult {
	readonly fixture: string;
	readonly size: number;
	readonly generation: string;
	readonly oracleDigest: string;
	readonly stableDiagnosticCount?: number;
	readonly counts: {
		readonly files: number;
		readonly symbols: number;
		readonly tests: number;
		readonly edges: number;
		readonly aliases: number;
	};
}

describe("Repo Map performance benchmark", () => {
	it("keeps the deterministic module fixture generation and semantic oracle stable", async () => {
		const first = await runWorker("modules");
		const second = await runWorker("modules");

		expect(second.generation).toBe(first.generation);
		expect(second.oracleDigest).toBe(first.oracleDigest);
		expect(second.counts).toEqual(first.counts);
		expect(first).toMatchObject({
			fixture: "modules",
			size: 4,
			oracleDigest: "0439de4cc0f4f63591c969bbb047bee4bda5c2f9f4364c844d9c7265eee403fd",
			counts: { files: 5, symbols: 6, tests: 0, edges: 54, aliases: 33 },
		});
	}, 0);

	it("keeps the test-dense stable-diagnostic graph and semantic oracle deterministic", async () => {
		const first = await runWorker("test-dense");
		const second = await runWorker("test-dense");

		expect(second.generation).toBe(first.generation);
		expect(second.oracleDigest).toBe(first.oracleDigest);
		expect(second.counts).toEqual(first.counts);
		expect(first).toMatchObject({
			fixture: "test-dense-stable-diagnostic",
			size: 4,
			stableDiagnosticCount: 1,
			oracleDigest: "a03520cec7819f4e1d3ea91ede06f20e18106fe0c3d6f09abf05562660464440",
			counts: { files: 19, symbols: 4, tests: 9, edges: 140, aliases: 141 },
		});
	}, 0);
});

async function runWorker(fixture: "modules" | "test-dense"): Promise<BenchmarkResult> {
	const fixtureArgs = fixture === "modules" ? [] : ["--fixture=test-dense"];
	const { stdout } = await execFileAsync(process.execPath, [worker, ...fixtureArgs, "--size=4"], {
		cwd: fileURLToPath(new URL("../..", import.meta.url)),
	});
	return parseResult(stdout);
}

function parseResult(output: string): BenchmarkResult {
	const value: unknown = JSON.parse(output);
	if (!isRecord(value) || typeof value["fixture"] !== "string" || typeof value["size"] !== "number"
		|| typeof value["generation"] !== "string" || typeof value["oracleDigest"] !== "string" || !isRecord(value["counts"])) {
		throw new Error("Repo Map benchmark worker returned an invalid result");
	}
	const counts = value["counts"];
	const stableDiagnosticCount = value["stableDiagnosticCount"];
	if (stableDiagnosticCount !== undefined && typeof stableDiagnosticCount !== "number") {
		throw new Error("Repo Map benchmark worker returned an invalid diagnostic count");
	}
	return {
		fixture: value["fixture"],
		size: value["size"],
		generation: value["generation"],
		oracleDigest: value["oracleDigest"],
		...(stableDiagnosticCount === undefined ? {} : { stableDiagnosticCount }),
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
