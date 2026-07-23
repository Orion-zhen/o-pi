import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readRuns } from "./benchmark/cli.mjs";
import { measureInteractiveReady, measureJsonWorker, measureProcess } from "./benchmark/runtime.mjs";
import { row } from "./benchmark/stats.mjs";

const worker = fileURLToPath(new URL("./workers/bench-web-tools-worker.mjs", import.meta.url));
const parserWorker = worker;
const args = process.argv.slice(2);
const runs = readRuns(args);
const warmups = Math.min(2, runs);
const pi = process.env.PI_BIN ?? "pi";
const piArgs = [
	"--offline", "--no-extensions", "--no-skills", "--no-prompt-templates",
	"--no-themes", "--no-context-files", "--list-models", "__web_tools_benchmark_no_match__",
];

const bare = measureProcess(pi, piArgs, { warmups, runs });
const extension = measureProcess(pi, [
	...piArgs.slice(0, -2), "--extension", "agent/extensions/web-tools.ts", ...piArgs.slice(-2),
], { warmups, runs });
const search = measureJsonWorker(worker, ["search"], { warmups, runs });
const fetch = measureJsonWorker(worker, ["fetch"], { warmups, runs });
const skippedImage = measureJsonWorker(worker, ["fetch-image-skip"], { warmups, runs });
const parser = measureJsonWorker(parserWorker, ["parser"], { warmups, runs });
const htmlWarmups = Math.min(1, runs);
const htmlScenarios = ["deferred", "video", "article", "hostile"];
const html = Object.fromEntries(htmlScenarios.map((scenario) => [
	scenario,
	measureJsonWorker(worker, ["html", scenario], { warmups: htmlWarmups, runs }),
]));
const readyRows = existsSync("/usr/bin/script") ? await measureReadyRows() : [];

console.log(`web-tools benchmark (${runs} measured runs, ${warmups} startup warmups/${htmlWarmups} HTML warmup; process-cold/filesystem-warm; fake network)`);
console.table([
	...readyRows,
	row("Pi bare load", bare),
	row("Pi + web-tools load", extension),
	row("web-tools load delta", extension.map((value, index) => value - bare[index])),
	row("web-tools Jiti import + register", search.map((sample) => sample.registrationMs)),
	row("first fake websearch", search.map((sample) => sample.firstToolMs)),
	row("warm fake websearch", search.map((sample) => sample.warmToolMs)),
	row("first fake source webfetch", fetch.map((sample) => sample.firstToolMs)),
	row("warm fake source webfetch", fetch.map((sample) => sample.warmToolMs)),
	row("first skipped direct image", skippedImage.map((sample) => sample.firstToolMs)),
	row("warm skipped direct image", skippedImage.map((sample) => sample.warmToolMs)),
	row("DDG parser Jiti import", parser.map((sample) => sample.importMs)),
	row("first DDG fixture parse", parser.map((sample) => sample.firstParseMs)),
	row("warm DDG fixture parse", parser.map((sample) => sample.warmParseMs)),
	...htmlScenarios.map((scenario) => row(
		`HTML ${scenario} conversion`,
		html[scenario].map((sample) => sample.conversionMs),
	)),
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

async function measureReadyRows() {
	const readyArgs = [
		"--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
		"--no-themes", "--no-context-files", "--no-tools", "--thinking", "off",
	];
	const readyOptions = { warmups, runs, readyMarker: "-----------------------------", env: { ...process.env, PI_TIMING: "1" } };
	const bareReady = await measureInteractiveReady(pi, readyArgs, readyOptions);
	const extensionReady = await measureInteractiveReady(pi, [
		...readyArgs, "--extension", "agent/extensions/web-tools.ts",
	], readyOptions);
	return [
		row("Pi bare ready", bareReady),
		row("Pi + web-tools ready", extensionReady),
		row("web-tools ready delta", extensionReady.map((value, index) => value - bareReady[index])),
	];
}
