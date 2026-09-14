import { fileURLToPath } from "node:url";
import { readRuns } from "./benchmark/cli.mjs";
import { measureJsonWorker } from "./benchmark/runtime.mjs";
import { row } from "./benchmark/stats.mjs";

const worker = fileURLToPath(new URL("./workers/bench-file-tools-worker.mjs", import.meta.url));
const runs = readRuns(process.argv.slice(2));
const warmups = Math.min(2, runs);
const samples = measureJsonWorker(worker, [], { warmups, runs });
console.log(`file-tools benchmark (${runs} measured runs, ${warmups} warmups; process-cold/filesystem-warm)`);
console.table([
	row("file-tools Bun import + register", samples.map((sample) => sample.registrationMs)),
	row("first ls after register", samples.map((sample) => sample.firstToolMs)),
]);
