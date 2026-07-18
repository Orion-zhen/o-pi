import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const worker = fileURLToPath(new URL("./bench-web-tools-worker.mjs", import.meta.url));
const parserWorker = fileURLToPath(new URL("./bench-web-tools-parser-worker.mjs", import.meta.url));
const runs = readRuns(process.argv.slice(2));
const warmups = Math.min(2, runs);
const pi = process.env.PI_BIN ?? "pi";
const piArgs = [
	"--offline",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
	"--list-models",
	"__web_tools_benchmark_no_match__",
];

const bare = measureProcess(pi, piArgs, warmups, runs);
const extension = measureProcess(pi, [
	...piArgs.slice(0, -2),
	"--extension",
	"agent/extensions/web-tools.ts",
	...piArgs.slice(-2),
], warmups, runs);
const search = measureWorker("search", warmups, runs);
const fetch = measureWorker("fetch", warmups, runs);
const parser = measureParserWorker(warmups, runs);
const readyRows = existsSync("/usr/bin/script") ? await measureReadyRows() : [];

console.log(`web-tools benchmark (${runs} measured runs, ${warmups} warmups; process-cold/filesystem-warm; fake network)`);
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
	row("DDG parser Jiti import", parser.map((sample) => sample.importMs)),
	row("first DDG fixture parse", parser.map((sample) => sample.firstParseMs)),
	row("warm DDG fixture parse", parser.map((sample) => sample.warmParseMs)),
]);

async function measureReadyRows() {
	const args = [
		"--offline",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-tools",
		"--thinking",
		"off",
	];
	const bareReady = await measureInteractive(args, warmups, runs);
	const extensionReady = await measureInteractive([...args, "--extension", "agent/extensions/web-tools.ts"], warmups, runs);
	return [
		row("Pi bare ready", bareReady),
		row("Pi + web-tools ready", extensionReady),
		row("web-tools ready delta", extensionReady.map((value, index) => value - bareReady[index])),
	];
}

function measureProcess(command, args, warmupCount, measuredCount) {
	const samples = [];
	for (let index = 0; index < warmupCount + measuredCount; index += 1) {
		const started = performance.now();
		run(command, args);
		if (index >= warmupCount) samples.push(performance.now() - started);
	}
	return samples;
}

function measureWorker(mode, warmupCount, measuredCount) {
	const samples = [];
	for (let index = 0; index < warmupCount + measuredCount; index += 1) {
		const output = run(process.execPath, [worker, mode], true);
		if (index >= warmupCount) samples.push(JSON.parse(output));
	}
	return samples;
}

function measureParserWorker(warmupCount, measuredCount) {
	const samples = [];
	for (let index = 0; index < warmupCount + measuredCount; index += 1) {
		const output = run(process.execPath, [parserWorker], true);
		if (index >= warmupCount) samples.push(JSON.parse(output));
	}
	return samples;
}

async function measureInteractive(args, warmupCount, measuredCount) {
	const command = [pi, ...args].map(shellQuote).join(" ");
	const samples = [];
	for (let index = 0; index < warmupCount + measuredCount; index += 1) {
		const elapsed = await runUntilReady(command);
		if (index >= warmupCount) samples.push(elapsed);
	}
	return samples;
}

async function runUntilReady(command) {
	const started = performance.now();
	const child = spawn("/usr/bin/script", ["-qfec", command, "/dev/null"], {
		cwd: root,
		detached: true,
		env: { ...process.env, PI_TIMING: "1" },
		stdio: ["ignore", "pipe", "ignore"],
	});
	const exited = once(child, "exit");
	let output = "";
	try {
		for await (const chunk of child.stdout) {
			output = `${output}${chunk}`.slice(-2_000);
			if (output.includes("-----------------------------")) return performance.now() - started;
		}
		throw new Error("pi exited before reporting startup timings");
	} finally {
		if (child.pid !== undefined) {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				// The process group already exited.
			}
		}
		await exited;
	}
}

function run(command, args, capture = false) {
	const result = spawnSync(command, args, {
		cwd: root,
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) throw new Error(`${command} exited with ${result.status}: ${result.stderr ?? ""}`);
	return result.stdout?.trim() ?? "";
}

function shellQuote(value) {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function row(metric, samples) {
	const sorted = [...samples].sort((left, right) => left - right);
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
