import { fileURLToPath } from "node:url";
import { readRuns, readSizes } from "./benchmark/cli.mjs";
import { measureJsonWorker } from "./benchmark/runtime.mjs";
import { row } from "./benchmark/stats.mjs";

const worker = fileURLToPath(new URL("./workers/bench-code-index-worker.mjs", import.meta.url));
const args = process.argv.slice(2);
const runs = readRuns(args, { defaultRuns: 3, minimum: 1 });
const sizes = readSizes(args, "--sizes", "4000,8000,16000");
const scenarios = ["ascii", "unicode", "dense", "long-line", "import-heavy"];
const warmups = Math.min(1, runs);

console.log(`code-index benchmark (${runs} measured runs, ${warmups} warmup; cold process/filesystem-independent fixture)`);
for (const scenario of scenarios) for (const size of sizes) {
	const samples = measureJsonWorker(worker, [`--size=${size}`, `--scenario=${scenario}`], { warmups, runs });
	const sample = samples[0];
	if (sample === undefined) throw new Error(`missing code-index benchmark sample for ${size}`);
	console.log(`Fixture: ${scenario}, ${size} declarations`);
	console.table([
		row("cold parse ms", samples.map((value) => value.coldParseMs)),
		row("warm parse ms", samples.map((value) => value.warmParseMs)),
		row("local batch ms", samples.map((value) => value.localBatchMs)),
		row("worker batch ms", samples.map((value) => value.workerBatchMs)),
		row("RSS MB", samples.map((value) => value.rssMb)),
	]);
	console.log({
		scenario: sample.scenario,
		size: sample.size,
		oracleDigest: sample.oracleDigest,
		counts: sample.counts,
		completeRuns: samples.filter((value) => value.complete).length,
	});
}
