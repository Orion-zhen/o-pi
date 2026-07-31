import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readRuns } from "./benchmark/cli.mjs";
import { measureInteractiveReady, measureJsonWorker, measureProcess, SCRIPT_BIN } from "./benchmark/runtime.mjs";
import { row } from "./benchmark/stats.mjs";

const worker = fileURLToPath(new URL("./workers/bench-file-tools-worker.mjs", import.meta.url));
const runs = readRuns(process.argv.slice(2));
const warmups = Math.min(2, runs);
const pi = process.env.PI_BIN ?? "pi";
const piArgs = [
	"--offline", "--no-extensions", "--no-skills", "--no-prompt-templates",
	"--no-themes", "--no-context-files", "--list-models", "__file_tools_benchmark_no_match__",
];

const bare = measureProcess(pi, piArgs, { warmups, runs });
const extension = measureProcess(pi, [
	...piArgs.slice(0, -2), "--extension", "agent/extensions/file-tools.ts", ...piArgs.slice(-2),
], { warmups, runs });
const toolSamples = measureJsonWorker(worker, [], { warmups, runs });
const readyRows = existsSync(SCRIPT_BIN) ? await measureReadyRows() : [];

const rows = [
	...readyRows,
	row("Pi bare load", bare),
	row("Pi + file-tools", extension),
	row("file-tools startup delta", extension.map((value, index) => value - bare[index])),
	row("file-tools Jiti import + register", toolSamples.map((sample) => sample.registrationMs)),
	row("first ls after register", toolSamples.map((sample) => sample.firstToolMs)),
];

console.log(`file-tools benchmark (${runs} measured runs, ${warmups} warmups; process-cold/filesystem-warm)`);
console.table(rows);

async function measureReadyRows() {
	const args = [
		"--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
		"--no-themes", "--no-context-files", "--no-tools", "--thinking", "off",
	];
	const readyOptions = { warmups, runs, readyMarker: "-----------------------------", env: { ...process.env, PI_TIMING: "1" } };
	const bareReady = await measureInteractiveReady(pi, args, readyOptions);
	const extensionReady = await measureInteractiveReady(pi, [
		...args, "--extension", "agent/extensions/file-tools.ts",
	], readyOptions);
	return [
		row("Pi bare ready", bareReady),
		row("Pi + file-tools ready", extensionReady),
		row("file-tools ready delta", extensionReady.map((value, index) => value - bareReady[index])),
	];
}
