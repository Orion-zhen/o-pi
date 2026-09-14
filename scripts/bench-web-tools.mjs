import { fileURLToPath } from "node:url";
import { readRuns } from "./benchmark/cli.mjs";
import { measureJsonWorker } from "./benchmark/runtime.mjs";
import { row } from "./benchmark/stats.mjs";

const worker = fileURLToPath(new URL("./workers/bench-web-tools-worker.mjs", import.meta.url));
const runs = readRuns(process.argv.slice(2));
const warmups = Math.min(2, runs);
const search = measureJsonWorker(worker, ["search"], { warmups, runs });
const fetch = measureJsonWorker(worker, ["fetch"], { warmups, runs });
const skippedImage = measureJsonWorker(worker, ["fetch-image-skip"], { warmups, runs });
const parser = measureJsonWorker(worker, ["parser"], { warmups, runs });
const htmlWarmups = Math.min(1, runs);
const htmlScenarios = ["deferred", "video", "article", "hostile"];
const html = Object.fromEntries(htmlScenarios.map((scenario) => [
	scenario,
	measureJsonWorker(worker, ["html", scenario], { warmups: htmlWarmups, runs }),
]));
console.log(`web-tools benchmark (${runs} measured runs, ${warmups} startup warmups/${htmlWarmups} HTML warmup; process-cold/filesystem-warm; fake network)`);
console.table([
	row("web-tools Bun import + register", search.map((sample) => sample.registrationMs)),
	row("first fake websearch", search.map((sample) => sample.firstToolMs)),
	row("warm fake websearch", search.map((sample) => sample.warmToolMs)),
	row("first fake source webfetch", fetch.map((sample) => sample.firstToolMs)),
	row("warm fake source webfetch", fetch.map((sample) => sample.warmToolMs)),
	row("first skipped direct image", skippedImage.map((sample) => sample.firstToolMs)),
	row("warm skipped direct image", skippedImage.map((sample) => sample.warmToolMs)),
	row("DDG parser Bun import", parser.map((sample) => sample.importMs)),
	row("first DDG fixture parse", parser.map((sample) => sample.firstParseMs)),
	row("warm DDG fixture parse", parser.map((sample) => sample.warmParseMs)),
	...htmlScenarios.map((scenario) => row(`HTML ${scenario} conversion`, html[scenario].map((sample) => sample.conversionMs))),
]);
console.table(htmlScenarios.map((scenario) => ({
	scenario,
	"input MB": median(html[scenario].map((sample) => sample.inputMb)),
	"max RSS MB": median(html[scenario].map((sample) => sample.maxRssMb)),
})));

function median(values) {
	const sorted = [...values].sort((left, right) => left - right);
	return Math.round((sorted[Math.floor(sorted.length / 2)] ?? 0) * 10) / 10;
}
