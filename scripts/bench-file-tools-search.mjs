import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const worker = fileURLToPath(new URL("./bench-file-tools-search-worker.mjs", import.meta.url));
const runs = readRuns(process.argv.slice(2));
const warmups = Math.min(1, runs);
const samples = [];

for (let index = 0; index < warmups + runs; index += 1) {
	const result = spawnSync(process.execPath, [worker], { cwd: root, encoding: "utf8" });
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) throw new Error(`search benchmark worker exited with ${result.status}: ${result.stderr}`);
	if (index >= warmups) samples.push(JSON.parse(result.stdout.trim()));
}

console.log(`file-tools search benchmark (${runs} measured runs, ${warmups} warmup; process-cold/filesystem-warm)`);
console.table(Object.keys(samples[0]).map((metric) => row(metric, samples.map((sample) => sample[metric]))));

function row(metric, values) {
	const sorted = [...values].sort((left, right) => left - right);
	return {
		metric,
		"p50 ms": round(percentile(sorted, 0.5)),
		"p95 ms": round(percentile(sorted, 0.95)),
		"min ms": round(sorted[0]),
	};
}

function percentile(sorted, quantile) {
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function round(value) {
	return Math.round(value * 10) / 10;
}

function readRuns(args) {
	const flag = args.find((arg) => arg.startsWith("--runs="));
	const value = Number(flag?.slice("--runs=".length) ?? 7);
	if (!Number.isInteger(value) || value < 3) throw new Error("--runs must be an integer >= 3");
	return value;
}
