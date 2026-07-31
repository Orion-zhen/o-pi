import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../..", import.meta.url));
export const agentRoot = `${root}/agent`;
export const SCRIPT_BIN = "/usr/bin/script";

export function benchmarkEnv(extra = {}) {
	return { ...process.env, PI_CODING_AGENT_DIR: agentRoot, PI_OFFLINE: "1", ...extra };
}

export function run(command, args, options = {}) {
	const normalized = typeof options === "boolean" ? { capture: options, env: benchmarkEnv() } : options;
	const result = spawnSync(command, args, {
		cwd: normalized.cwd ?? root,
		env: normalized.env ?? process.env,
		encoding: "utf8",
		maxBuffer: normalized.maxBuffer ?? 20 * 1024 * 1024,
		stdio: normalized.capture ? ["ignore", "pipe", "pipe"] : "ignore",
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) throw new Error(`${command} exited with ${result.status}: ${result.stderr ?? ""}`);
	return result.stdout?.trim() ?? "";
}

export function measureProcess(command, args, { warmups, runs, ...options }) {
	const samples = [];
	for (let index = 0; index < warmups + runs; index += 1) {
		const started = performance.now();
		run(command, args, options);
		if (index >= warmups) samples.push(performance.now() - started);
	}
	return samples;
}

export function measureJsonWorker(worker, args, { warmups, runs, ...options }) {
	const samples = [];
	for (let index = 0; index < warmups + runs; index += 1) {
		const output = run(process.execPath, [worker, ...args], { ...options, capture: true });
		if (index >= warmups) {
			try {
				samples.push(JSON.parse(output));
			} catch (error) {
				throw new Error(`benchmark worker returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return samples;
}

export function measureOperation(operation, { warmups, runs }) {
	const samples = [];
	for (let index = 0; index < warmups + runs; index += 1) {
		const started = performance.now();
		operation();
		if (index >= warmups) samples.push(performance.now() - started);
	}
	return samples;
}

export async function measureAsyncOperation(operation, { warmups, runs }) {
	const samples = [];
	for (let index = 0; index < warmups + runs; index += 1) {
		const started = performance.now();
		await operation();
		if (index >= warmups) samples.push(performance.now() - started);
	}
	return samples;
}

export async function measureInteractiveReady(command, args, { warmups, runs, readyMarker, env = process.env, timeoutMs = 20_000 }) {
	const samples = [];
	for (let index = 0; index < warmups + runs; index += 1) {
		const elapsed = await runUntilReady(command, args, { readyMarker, env, timeoutMs });
		if (index >= warmups) samples.push(elapsed);
	}
	return samples;
}

export function scriptArgs(command, args, platform = process.platform) {
	if (platform !== "linux") return ["-q", "/dev/null", command, ...args];
	return ["-qfec", [command, ...args].map(shellQuote).join(" "), "/dev/null"];
}

export function spawnInteractive(command, args, options) {
	return spawn(SCRIPT_BIN, scriptArgs(command, args), options);
}

async function runUntilReady(command, args, { readyMarker, env, timeoutMs }) {
	const started = performance.now();
	const child = spawnInteractive(command, args, {
		cwd: root,
		detached: true,
		env,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const exited = once(child, "exit");
	let timer;
	let output = "";
	try {
		await new Promise((resolve, reject) => {
			timer = setTimeout(() => reject(new Error("benchmark interactive startup timed out")), timeoutMs);
			child.stdout.on("data", (chunk) => {
				output = `${output}${chunk}`.slice(-2_000);
				if (output.includes(readyMarker)) resolve();
			});
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`process exited before ready marker (${code})`)));
		});
		return performance.now() - started;
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

export function shellQuote(value) {
	return `'${value.replaceAll("'", `\'"'"\'`)}'`;
}
