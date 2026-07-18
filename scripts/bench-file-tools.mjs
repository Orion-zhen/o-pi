import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const worker = fileURLToPath(new URL("./bench-file-tools-worker.mjs", import.meta.url));
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
	"__file_tools_benchmark_no_match__",
];

const bare = measureProcess(pi, piArgs, warmups, runs);
const extension = measureProcess(pi, [
	...piArgs.slice(0, -2),
	"--extension",
	"agent/extensions/file-tools.ts",
	...piArgs.slice(-2),
], warmups, runs);
const toolSamples = measureWorker(warmups, runs);
const readyRows = existsSync("/usr/bin/script") ? await measureReadyRows() : [];

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
	const extensionReady = await measureInteractive([
		...args,
		"--extension",
		"agent/extensions/file-tools.ts",
	], warmups, runs);
	return [
		row("Pi bare ready", bareReady),
		row("Pi + file-tools ready", extensionReady),
		row("file-tools ready delta", extensionReady.map((value, index) => value - bareReady[index])),
	];
}

function measureProcess(command, args, warmupCount, measuredCount) {
	const samples = [];
	for (let index = 0; index < warmupCount + measuredCount; index += 1) {
		const start = performance.now();
		run(command, args);
		const elapsed = performance.now() - start;
		if (index >= warmupCount) samples.push(elapsed);
	}
	return samples;
}

function measureWorker(warmupCount, measuredCount) {
	const samples = [];
	for (let index = 0; index < warmupCount + measuredCount; index += 1) {
		const output = run(process.execPath, [worker], true);
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

function row(name, samples) {
	const sorted = [...samples].sort((left, right) => left - right);
	return {
		metric: name,
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
