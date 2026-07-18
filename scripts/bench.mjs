import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const agentRoot = path.join(root, "agent");
const lazyWorker = fileURLToPath(new URL("./bench-lazy-components-worker.mjs", import.meta.url));
const pi = process.env.PI_BIN ?? "pi";
const SCRIPT_BIN = "/usr/bin/script";
const MAIN_TIMING_HEADER = "--- Startup Timings: main ---";
const MAIN_TIMING_FOOTER = "-----------------------------";
const EXTENSION_TIMING_HEADER = "--- Startup Timings: extensions ---";
const EXTENSION_TIMING_FOOTER = "-----------------------------------";
const CORE_FLAGS = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];
const AGENT_LOOP_TOOL_METRICS = [
	["lsColdMs", "ls cold round trip"],
	["lsWarmMs", "ls warm round trip"],
	["findColdMs", "find cold round trip"],
	["findWarmMs", "find warm round trip"],
	["grepColdMs", "grep cold round trip"],
	["grepWarmMs", "grep warm round trip"],
];
const AGENT_LOOP_TOOL_CALLS = [
	{ name: "ls", arguments: { path: "scripts" } },
	{ name: "ls", arguments: { path: "scripts" } },
	{ name: "find", arguments: { query: "bench*.mjs", path: "scripts" } },
	{ name: "find", arguments: { query: "bench*.mjs", path: "scripts" } },
	{ name: "grep", arguments: { query: "runAgentLoopSuite", path: "scripts", match: "literal", glob: "*.mjs" } },
	{ name: "grep", arguments: { query: "runAgentLoopSuite", path: "scripts", match: "literal", glob: "*.mjs" } },
];
const DEFAULT_SUITES = ["startup", "agent-loop", "lazy", "file-tools", "file-search", "repo-map", "web-tools"];
const options = readOptions(process.argv.slice(2));

if (options.help) {
	printHelp();
	process.exit(0);
}

const environment = readEnvironment();
printEnvironment(environment, options);
const results = { environment, options: serializableOptions(options) };

if (options.suites.has("startup")) results.startup = await runStartupSuite();
if (options.suites.has("agent-loop")) results.agentLoop = await runAgentLoopSuite();
if (options.suites.has("lazy")) results.lazy = runLazyComponentsSuite();
if (options.suites.has("file-tools")) runExternalSuite("file-tools", "bench-file-tools.mjs", [`--runs=${options.runs}`]);
if (options.suites.has("file-search")) runExternalSuite("file-tools search", "bench-file-tools-search.mjs", [`--runs=${options.runs}`]);
if (options.suites.has("repo-map")) runExternalSuite("repo-map", "bench-repo-map.mjs", [`--runs=${options.runs}`, `--sizes=${options.repoSizes.join(",")}`]);
if (options.suites.has("web-tools")) runExternalSuite("web-tools", "bench-web-tools.mjs", [`--runs=${options.runs}`]);

if (options.jsonPath !== undefined) {
	const target = path.resolve(root, options.jsonPath);
	await writeFile(target, `${JSON.stringify(results, null, 2)}\n`);
	console.log(`\nJSON report: ${target}`);
}

async function runStartupSuite() {
	printHeading("Pi startup and extension breakdown");
	console.log("Startup runs are process-cold/filesystem-warm. Network startup work is disabled.");
	const scenarios = [
		{ id: "core", label: "Pi core", flags: CORE_FLAGS },
		{ id: "resources", label: "Pi + resources", flags: ["--no-extensions"] },
		{ id: "full", label: "Pi + all extensions", flags: [] },
	];
	const processSamples = createScenarioSamples(scenarios);
	for (let iteration = 0; iteration < options.warmups + options.runs; iteration += 1) {
		for (const scenario of rotate(scenarios, iteration)) {
			const elapsed = measureProcessStartup(scenario.flags);
			if (iteration >= options.warmups) processSamples.get(scenario.id).push(elapsed);
		}
	}
	console.log("\nNon-interactive CLI load (--list-models, no session)");
	console.table(scenarioRows(scenarios, processSamples));
	console.table(deltaRows(scenarios, processSamples));

	let tuiSamples;
	let profiles = [];
	if (existsSync(SCRIPT_BIN)) {
		tuiSamples = createScenarioSamples(scenarios);
		for (let iteration = 0; iteration < options.warmups + options.runs; iteration += 1) {
			for (const scenario of rotate(scenarios, iteration)) {
				const measured = await measureTuiStartup(scenario.flags, scenario.id === "full");
				if (iteration >= options.warmups) {
					tuiSamples.get(scenario.id).push(measured.elapsedMs);
					if (scenario.id === "full") profiles.push(parseTimingProfile(measured.output));
				}
			}
		}
		console.log("\nInteractive startup (Pi timing tables complete, before idle work)");
		console.table(scenarioRows(scenarios, tuiSamples));
		console.table(deltaRows(scenarios, tuiSamples));
		printMainTimingProfiles(profiles);
		printExtensionTimingProfiles(profiles);
	} else {
		console.log(`\nInteractive startup skipped: ${SCRIPT_BIN} is unavailable.`);
	}

	return {
		process: samplesToObject(processSamples),
		...(tuiSamples === undefined ? {} : { tui: samplesToObject(tuiSamples) }),
		mainTimings: aggregateMainProfiles(profiles),
		extensionTimings: aggregateExtensionProfiles(profiles),
	};
}

async function runAgentLoopSuite() {
	printHeading("Model → tool → model CLI loop");
	console.log("A local immediate-response model triggers this repository's cold/warm replacement ls, find and grep tools. No external model or network latency is included.");
	const temp = await mkdtemp(path.join(os.tmpdir(), "o-pi-agent-loop-bench-"));
	let activeRun;
	const server = createServer(async (request, response) => {
		try {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			if (request.url?.endsWith("/models")) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end('{"data":[{"id":"bench"}]}');
				return;
			}
			if (!request.url?.endsWith("/chat/completions")) {
				response.writeHead(404).end();
				return;
			}
			if (activeRun === undefined) throw new Error("model request arrived outside an active benchmark run");
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const toolResultCount = Array.isArray(body.messages) ? body.messages.filter((message) => message.role === "tool").length : 0;
			if (toolResultCount === 0) assertReplacementToolSchemas(body.tools);
			const toolCall = activeRun.toolCalls[toolResultCount];
			activeRun.requestTimes[toolResultCount] = performance.now();
			writeChatCompletion(response, toolResultCount, toolCall);
			activeRun.responseTimes[toolResultCount] = performance.now();
		} catch (error) {
			if (activeRun !== undefined) activeRun.serverError = stringifyError(error);
			if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
			response.end(stringifyError(error));
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("benchmark server did not expose a TCP port");
	const providerPath = path.join(temp, "benchmark-provider.mjs");
	await writeFile(providerPath, benchmarkProviderSource(address.port));

	const samples = [];
	try {
		for (let iteration = 0; iteration < options.warmups + options.runs; iteration += 1) {
			activeRun = { requestTimes: [], responseTimes: [], toolCalls: AGENT_LOOP_TOOL_CALLS };
			const measured = await measureAgentLoop(providerPath, activeRun);
			activeRun = undefined;
			if (iteration >= options.warmups) samples.push(measured);
		}
	} finally {
		server.close();
		await once(server, "close");
		await rm(temp, { recursive: true, force: true });
	}

	const metrics = [
		["totalMs", "total CLI task"],
		["toFirstModelRequestMs", "startup → first model request"],
		...AGENT_LOOP_TOOL_METRICS,
		["afterFinalResponseMs", "final model response → process exit"],
	];
	const rows = metrics.map(([key, label]) => {
		const summary = summarize(samples.map((sample) => sample[key]));
		return { metric: label, "p50 ms": summary.p50, "p95 ms": summary.p95, "min ms": summary.min, "max ms": summary.max };
	});
	console.table(rows);
	return aggregateObjectSamples(samples);
}

function runLazyComponentsSuite() {
	printHeading("Deferred component cold/warm cost");
	const output = {};
	for (const mode of ["tokenizer", "math"]) {
		const samples = [];
		for (let iteration = 0; iteration < options.warmups + options.runs; iteration += 1) {
			const value = JSON.parse(run(process.execPath, [lazyWorker, mode], true));
			if (iteration >= options.warmups) samples.push(value);
		}
		output[mode] = aggregateObjectSamples(samples);
		console.log(`\n${mode}`);
		console.table(numericMetricRows(samples));
	}
	return output;
}

function runExternalSuite(label, scriptName, args) {
	if (options.runs < 3 && scriptName !== "bench-repo-map.mjs") {
		throw new Error(`${label} requires --runs >= 3`);
	}
	printHeading(`${label} specialized benchmark`);
	const script = fileURLToPath(new URL(`./${scriptName}`, import.meta.url));
	const result = spawnSync(process.execPath, [script, ...args], {
		cwd: root,
		env: benchmarkEnv(),
		stdio: "inherit",
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) throw new Error(`${label} benchmark exited with ${result.status}`);
}

function measureProcessStartup(flags) {
	const started = performance.now();
	run(pi, ["--offline", "--no-session", ...flags, "--list-models", "__o_pi_benchmark_no_match__"], false);
	return performance.now() - started;
}

async function measureTuiStartup(flags, expectExtensionTimings) {
	const command = [pi, "--offline", "--no-session", ...flags, "--thinking", "off"].map(shellQuote).join(" ");
	const started = performance.now();
	const child = spawn(SCRIPT_BIN, ["-qfec", command, "/dev/null"], {
		cwd: root,
		detached: true,
		env: { ...benchmarkEnv(), PI_TIMING: "1" },
		stdio: ["ignore", "pipe", "ignore"],
	});
	const exited = once(child, "exit");
	let timer;
	try {
		const output = await new Promise((resolve, reject) => {
			let captured = "";
			timer = setTimeout(() => reject(new Error("Pi interactive startup timed out")), 20_000);
			child.stdout.on("data", (chunk) => {
				captured = `${captured}${chunk}`.slice(-256_000);
				if (hasCompleteTimings(captured, expectExtensionTimings)) resolve(captured);
			});
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`Pi exited before startup timings completed (${code})`)));
		});
		return { elapsedMs: performance.now() - started, output };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
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

async function measureAgentLoop(providerPath, timing) {
	const started = performance.now();
	const child = spawn(pi, [
		"--offline",
		"--no-session",
		"--thinking", "off",
		"--extension", providerPath,
		"--model", "__o_pi_benchmark__/bench",
		"--tools", "ls,find,grep",
		"--print",
		"Execute the benchmark tool calls supplied by the model, then reply with only done.",
	], {
		cwd: root,
		env: benchmarkEnv(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
	const [code] = await once(child, "exit");
	clearTimeout(timeout);
	const ended = performance.now();
	const expectedModelRequests = timing.toolCalls.length + 1;
	if (code !== 0 || timing.serverError !== undefined || timing.requestTimes.length !== expectedModelRequests || timing.responseTimes.length !== expectedModelRequests) {
		throw new Error([
			`agent loop failed with exit ${code}`,
			`timing=${JSON.stringify(timing)}`,
			`stdout=${stdout.slice(-1_000)}`,
			`stderr=${stderr.slice(-1_000)}`,
		].join("\n"));
	}
	const measured = {
		totalMs: ended - started,
		toFirstModelRequestMs: timing.requestTimes[0] - started,
		afterFinalResponseMs: ended - timing.responseTimes.at(-1),
	};
	for (const [index, [metric]] of AGENT_LOOP_TOOL_METRICS.entries()) {
		measured[metric] = timing.requestTimes[index + 1] - timing.responseTimes[index];
	}
	return measured;
}

function writeChatCompletion(response, toolResultCount, toolCall) {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	const id = `chatcmpl-benchmark-${toolResultCount}`;
	const delta = toolCall !== undefined
		? {
			role: "assistant",
			tool_calls: [{
				index: 0,
				id: `call_${toolCall.name}_${toolResultCount + 1}`,
				type: "function",
				function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
			}],
		}
		: { role: "assistant", content: "done" };
	response.write(`data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created: 1,
		model: "bench",
		choices: [{ index: 0, delta, finish_reason: null }],
	})}\n\n`);
	response.write(`data: ${JSON.stringify({
		id,
		object: "chat.completion.chunk",
		created: 1,
		model: "bench",
		choices: [{ index: 0, delta: {}, finish_reason: toolCall !== undefined ? "tool_calls" : "stop" }],
	})}\n\n`);
	response.end("data: [DONE]\n\n");
}

function assertReplacementToolSchemas(tools) {
	const schemas = new Map((Array.isArray(tools) ? tools : []).map((tool) => [tool.function?.name, tool.function?.parameters]));
	const findProperties = schemas.get("find")?.properties;
	const grepProperties = schemas.get("grep")?.properties;
	if (findProperties?.query === undefined || findProperties.pattern !== undefined || grepProperties?.query === undefined || grepProperties?.match === undefined || grepProperties.pattern !== undefined) {
		throw new Error("agent-loop requires this repository's replacement find/grep schemas; Pi built-in tools were registered instead");
	}
}

function benchmarkProviderSource(port) {
	return `export default function benchmarkProvider(pi) {
	pi.registerProvider("__o_pi_benchmark__", {
		name: "Local benchmark model",
		baseUrl: "http://127.0.0.1:${port}/v1",
		apiKey: "EMPTY",
		api: "openai-completions",
		models: [{
			id: "bench",
			name: "Benchmark",
			api: "openai-completions",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
		}],
	});
}
`;
}

function hasCompleteTimings(output, expectExtensionTimings) {
	const header = output.indexOf(expectExtensionTimings ? EXTENSION_TIMING_HEADER : MAIN_TIMING_HEADER);
	const timingHeader = expectExtensionTimings ? EXTENSION_TIMING_HEADER : MAIN_TIMING_HEADER;
	const footer = expectExtensionTimings ? EXTENSION_TIMING_FOOTER : MAIN_TIMING_FOOTER;
	return header !== -1 && output.indexOf(footer, header + timingHeader.length) !== -1;
}

function parseTimingProfile(output) {
	const main = parseMainTimings(extractTimingBlock(output, MAIN_TIMING_HEADER, MAIN_TIMING_FOOTER));
	const extensions = parseExtensionTimings(extractTimingBlock(output, EXTENSION_TIMING_HEADER, EXTENSION_TIMING_FOOTER));
	return { main, extensions };
}

function extractTimingBlock(output, header, footer) {
	const start = output.indexOf(header);
	if (start === -1) throw new Error(`Pi timing output is missing ${header}`);
	const contentStart = start + header.length;
	const end = output.indexOf(footer, contentStart);
	if (end === -1) throw new Error(`Pi timing output is missing footer for ${header}`);
	return output.slice(contentStart, end);
}

function parseMainTimings(block) {
	const timings = {};
	for (const line of block.split(/\r?\n/)) {
		const match = line.trim().match(/^([^:]+):\s*([\d.]+)ms$/);
		if (match !== null) timings[match[1]] = Number(match[2]);
	}
	return timings;
}

function parseExtensionTimings(block) {
	const timings = {};
	for (const line of block.split(/\r?\n/)) {
		const match = line.trim().match(/^(.+?) (module import|factory):\s*([\d.]+)ms$/);
		if (match === null) continue;
		const name = path.basename(match[1]).replace(/\.[^.]+$/, "");
		timings[name] ??= { importMs: 0, factoryMs: 0 };
		if (match[2] === "module import") timings[name].importMs = Number(match[3]);
		else timings[name].factoryMs = Number(match[3]);
	}
	return timings;
}

function printMainTimingProfiles(profiles) {
	console.log("\nPi internal main timing");
	const aggregated = aggregateMainProfiles(profiles);
	console.table(Object.entries(aggregated)
		.map(([metric, value]) => ({ metric, ...value }))
		.sort((left, right) => right["p50 ms"] - left["p50 ms"]));
}

function printExtensionTimingProfiles(profiles) {
	console.log("\nExtension import/factory timing (sorted by p50 total)");
	const aggregated = aggregateExtensionProfiles(profiles);
	console.table(Object.entries(aggregated)
		.map(([extension, value]) => ({ extension, ...value }))
		.sort((left, right) => right["total p50 ms"] - left["total p50 ms"]));
}

function aggregateMainProfiles(profiles) {
	const metrics = new Set(profiles.flatMap((profile) => Object.keys(profile.main)));
	return Object.fromEntries([...metrics].map((metric) => {
		const summary = summarize(profiles.map((profile) => profile.main[metric] ?? 0));
		return [metric, { "p50 ms": summary.p50, "p95 ms": summary.p95, "min ms": summary.min }];
	}));
}

function aggregateExtensionProfiles(profiles) {
	const names = new Set(profiles.flatMap((profile) => Object.keys(profile.extensions)));
	return Object.fromEntries([...names].map((name) => {
		const imports = profiles.map((profile) => profile.extensions[name]?.importMs ?? 0);
		const factories = profiles.map((profile) => profile.extensions[name]?.factoryMs ?? 0);
		const totals = imports.map((value, index) => value + factories[index]);
		return [name, {
			"import p50 ms": summarize(imports).p50,
			"factory p50 ms": summarize(factories).p50,
			"total p50 ms": summarize(totals).p50,
			"total p95 ms": summarize(totals).p95,
		}];
	}));
}

function numericMetricRows(samples) {
	return Object.keys(samples[0]).map((metric) => {
		const summary = summarize(samples.map((sample) => sample[metric]));
		const unit = metric.endsWith("Mb") ? "MB" : "ms";
		return { metric, unit, p50: summary.p50, p95: summary.p95, min: summary.min, max: summary.max };
	});
}

function aggregateObjectSamples(samples) {
	return Object.fromEntries(Object.keys(samples[0]).map((metric) => [metric, summarize(samples.map((sample) => sample[metric]))]));
}

function createScenarioSamples(scenarios) {
	return new Map(scenarios.map((scenario) => [scenario.id, []]));
}

function samplesToObject(samples) {
	return Object.fromEntries([...samples].map(([id, values]) => [id, summarize(values)]));
}

function scenarioRows(scenarios, samples) {
	const coreP50 = summarize(samples.get("core")).p50;
	return scenarios.map((scenario) => {
		const value = summarize(samples.get(scenario.id));
		return {
			scenario: scenario.label,
			"p50 ms": value.p50,
			"p95 ms": value.p95,
			"min ms": value.min,
			"max ms": value.max,
			"vs core ms": round(value.p50 - coreP50),
		};
	});
}

function deltaRows(scenarios, samples) {
	const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
	return [
		deltaRow(`${byId.get("core").label} → ${byId.get("resources").label}`, samples.get("core"), samples.get("resources")),
		deltaRow(`${byId.get("resources").label} → ${byId.get("full").label}`, samples.get("resources"), samples.get("full")),
		deltaRow(`${byId.get("core").label} → ${byId.get("full").label}`, samples.get("core"), samples.get("full")),
	];
}

function deltaRow(metric, baseline, measured) {
	const deltas = measured.map((value, index) => value - baseline[index]);
	const value = summarize(deltas);
	const baselineP50 = summarize(baseline).p50;
	return {
		increment: metric,
		"p50 ms": value.p50,
		"p95 ms": value.p95,
		"p50 %": round((value.p50 / baselineP50) * 100),
	};
}

function summarize(values) {
	if (values.length === 0) return { samples: [], min: 0, p50: 0, p95: 0, max: 0 };
	const sorted = [...values].sort((left, right) => left - right);
	return {
		samples: values.map(round),
		min: round(sorted[0]),
		p50: round(percentile(sorted, 0.5)),
		p95: round(percentile(sorted, 0.95)),
		max: round(sorted.at(-1)),
	};
}

function percentile(sorted, quantile) {
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function rotate(values, offset) {
	const index = offset % values.length;
	return [...values.slice(index), ...values.slice(0, index)];
}

function benchmarkEnv() {
	return {
		...process.env,
		PI_CODING_AGENT_DIR: agentRoot,
		PI_OFFLINE: "1",
	};
}

function run(command, args, capture) {
	const result = spawnSync(command, args, {
		cwd: root,
		env: benchmarkEnv(),
		encoding: "utf8",
		maxBuffer: 20 * 1024 * 1024,
		stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) throw new Error(`${command} exited with ${result.status}: ${result.stderr ?? ""}`);
	return result.stdout?.trim() ?? "";
}

function readEnvironment() {
	return {
		timestamp: new Date().toISOString(),
		commit: run("git", ["rev-parse", "--short", "HEAD"], true),
		pi: run(pi, ["--version"], true),
		node: process.version,
		platform: `${process.platform} ${os.release()} ${process.arch}`,
		cpu: os.cpus()[0]?.model ?? "unknown",
		logicalCpus: os.cpus().length,
	};
}

function printEnvironment(environment, benchmarkOptions) {
	console.log("o-pi comprehensive benchmark");
	console.table([{
		commit: environment.commit,
		pi: environment.pi,
		node: environment.node,
		platform: environment.platform,
		cpu: environment.cpu,
		"logical CPUs": environment.logicalCpus,
		runs: benchmarkOptions.runs,
		warmups: benchmarkOptions.warmups,
		suites: [...benchmarkOptions.suites].join(", "),
	}]);
}

function printHeading(text) {
	console.log(`\n=== ${text} ===`);
}

function shellQuote(value) {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function round(value) {
	return Math.round(value * 10) / 10;
}

function stringifyError(error) {
	return error instanceof Error ? error.message : String(error);
}

function readOptions(args) {
	const help = args.includes("--help") || args.includes("-h");
	const quick = args.includes("--quick");
	const runs = readIntegerFlag(args, "--runs", quick ? 3 : 7, 1);
	const warmups = readIntegerFlag(args, "--warmups", quick ? 1 : Math.min(2, runs), 0);
	const suitesFlag = readStringFlag(args, "--suites");
	const suiteNames = suitesFlag === undefined || suitesFlag === "all" ? DEFAULT_SUITES : suitesFlag.split(",").filter(Boolean);
	if (suiteNames.length === 0) throw new Error("--suites must select at least one suite");
	const unknownSuites = suiteNames.filter((suite) => !DEFAULT_SUITES.includes(suite));
	if (unknownSuites.length > 0) throw new Error(`unknown suites: ${unknownSuites.join(", ")}`);
	const minimumThreeSuites = new Set(["file-tools", "file-search", "web-tools"]);
	if (runs < 3 && suiteNames.some((suite) => minimumThreeSuites.has(suite))) {
		throw new Error("file-tools, file-search and web-tools suites require --runs >= 3");
	}
	const repoSizes = (readStringFlag(args, "--repo-sizes") ?? "100").split(",").map(Number);
	if (repoSizes.some((size) => !Number.isInteger(size) || size < 2 || size > 100_000)) {
		throw new Error("--repo-sizes must contain comma-separated integers between 2 and 100000");
	}
	const jsonPath = readStringFlag(args, "--json");
	if (jsonPath === "") throw new Error("--json requires a non-empty path");
	const known = ["--help", "-h", "--quick"];
	for (const arg of args) {
		if (known.includes(arg)) continue;
		if (["--runs=", "--warmups=", "--suites=", "--repo-sizes=", "--json="].some((prefix) => arg.startsWith(prefix))) continue;
		throw new Error(`unknown benchmark option: ${arg}`);
	}
	return { help, quick, runs, warmups, suites: new Set(suiteNames), repoSizes: [...new Set(repoSizes)], jsonPath };
}

function readIntegerFlag(args, name, fallback, minimum) {
	const value = Number(readStringFlag(args, name) ?? fallback);
	if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
	return value;
}

function readStringFlag(args, name) {
	const prefix = `${name}=`;
	return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function serializableOptions(value) {
	return { ...value, suites: [...value.suites] };
}

function printHelp() {
	console.log(`Usage: npm run bench -- [options]

Options:
  --quick                 Use 3 measured runs and 1 warmup.
  --runs=N                Measured process-cold runs (default: 7).
  --warmups=N             Warmup runs for unified suites (default: min(2, runs)).
  --suites=LIST           Comma-separated suites or all.
                          startup,agent-loop,lazy,file-tools,file-search,repo-map,web-tools
  --repo-sizes=LIST       Repo Map fixture sizes (default: 100).
  --json=PATH             Write structured unified-suite results to PATH.
  --help                  Show this help.

Examples:
  npm run bench
  npm run bench -- --quick
  npm run bench -- --runs=9 --suites=startup,agent-loop,lazy --json=bench.json
  npm run bench -- --runs=3 --suites=repo-map --repo-sizes=100,1000
`);
}
