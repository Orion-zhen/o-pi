import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = fileURLToPath(new URL("..", import.meta.url));
const extensionWorker = fileURLToPath(new URL("./bench-repo-map-extension-worker.mjs", import.meta.url));
const runtimeWorker = fileURLToPath(new URL("./bench-repo-map-worker.mjs", import.meta.url));
const options = readOptions(process.argv.slice(2));
const warmups = Math.min(1, options.runs);
const pi = process.env.PI_BIN ?? "pi";

const piArgs = [
	"--offline",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
	"--list-models",
	"__repo_map_benchmark_no_match__",
];
const bare = measureProcess(pi, piArgs, warmups, options.runs);
const extension = measureProcess(pi, [
	...piArgs.slice(0, -2),
	"--extension",
	"agent/extensions/repo-map.ts",
	...piArgs.slice(-2),
], warmups, options.runs);
const extensionSamples = measureJsonWorker(extensionWorker, [], warmups, options.runs);

console.log(`repo-map benchmark (${options.runs} measured runs, ${warmups} warmup; process-cold/filesystem-warm)`);
console.table([
	row("Pi bare load ms", bare),
	row("Pi + repo-map ms", extension),
	row("repo-map startup delta ms", extension.map((value, index) => value - bare[index])),
	...rowsForSamples(extensionSamples),
]);

for (const size of options.sizes) {
	const samples = measureJsonWorker(runtimeWorker, [`--size=${size}`], warmups, options.runs);
	assertStableOracle(samples, size);
	console.log(`Repo Map fixture: ${size} TypeScript modules (+ package.json)`);
	console.table(rowsForSamples(samples));
	const representative = samples[0];
	console.log({
		generation: representative.generation,
		oracleDigest: representative.oracleDigest,
		counts: representative.counts,
	});
}

function measureProcess(command, args, warmupCount, measuredCount) {
	const samples = [];
	for (let index = 0; index < warmupCount + measuredCount; index += 1) {
		const started = performance.now();
		run(command, args, false);
		if (index >= warmupCount) samples.push(performance.now() - started);
	}
	return samples;
}

function measureJsonWorker(worker, args, warmupCount, measuredCount) {
	const samples = [];
	for (let index = 0; index < warmupCount + measuredCount; index += 1) {
		const output = run(process.execPath, [worker, ...args], true);
		if (index >= warmupCount) samples.push(JSON.parse(output));
	}
	return samples;
}

function run(command, args, capture) {
	const result = spawnSync(command, args, {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
		stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) throw new Error(`${command} exited with ${result.status}: ${result.stderr ?? ""}`);
	return result.stdout?.trim() ?? "";
}

function rowsForSamples(samples) {
	const ignored = new Set(["size", "generation", "oracleDigest", "counts"]);
	return Object.keys(samples[0])
		.filter((key) => !ignored.has(key) && samples.every((sample) => typeof sample[key] === "number"))
		.map((metric) => row(metric, samples.map((sample) => sample[metric])));
}

function row(metric, values) {
	const sorted = [...values].sort((left, right) => left - right);
	return {
		metric,
		p50: round(percentile(sorted, 0.5)),
		p95: round(percentile(sorted, 0.95)),
		min: round(sorted[0]),
	};
}

function percentile(sorted, quantile) {
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function round(value) {
	return Math.round(value * 10) / 10;
}

function assertStableOracle(samples, size) {
	const generations = new Set(samples.map((sample) => sample.generation));
	const digests = new Set(samples.map((sample) => sample.oracleDigest));
	if (generations.size !== 1 || digests.size !== 1) {
		throw new Error(`Repo Map fixture ${size} produced non-deterministic generation or query output`);
	}
}

function readOptions(args) {
	const runsFlag = args.find((arg) => arg.startsWith("--runs="));
	const runs = Number(runsFlag?.slice("--runs=".length) ?? 3);
	if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be an integer >= 1");
	const sizesFlag = args.find((arg) => arg.startsWith("--sizes="));
	const sizes = (sizesFlag?.slice("--sizes=".length) ?? "100")
		.split(",")
		.map(Number);
	if (sizes.length === 0 || sizes.some((size) => !Number.isInteger(size) || size < 2 || size > 100_000)) {
		throw new Error("--sizes must be comma-separated integers between 2 and 100000");
	}
	return { runs, sizes: [...new Set(sizes)] };
}
