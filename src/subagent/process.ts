import { spawn as nodeSpawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { PiJsonProgressAccumulator } from "./json-progress.js";
import { formatModelReference } from "./model.js";
import type { ProcessRunInput, ProcessRunOutput, ProcessRunProgress } from "./types.js";

type SpawnFunction = (
	command: string,
	args: readonly string[],
	options: SpawnOptionsWithoutStdio,
) => SpawnedProcess;

interface SpawnedProcess {
	exitCode: number | null;
	stdin: NodeJS.WritableStream;
	stdout: NodeJS.ReadableStream;
	stderr: NodeJS.ReadableStream;
	kill(signal?: NodeJS.Signals | number): boolean;
	on(event: "close", listener: (code: number | null) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
}

let spawnImpl: SpawnFunction = nodeSpawn;

/** 测试注入点；生产环境始终使用 node:child_process.spawn 且 shell=false。 */
export function setSubagentSpawnForTests(spawn: SpawnFunction): void {
	spawnImpl = spawn;
}

export function resetSubagentSpawnForTests(): void {
	spawnImpl = nodeSpawn;
}

export async function runPiProcess(input: ProcessRunInput, options: { signal?: AbortSignal; onUpdate?: (progress: ProcessRunProgress) => void } = {}): Promise<ProcessRunOutput> {
	const start = Date.now();
	const progress = new PiJsonProgressAccumulator();
	let stdoutBuffer = "";
	let stderr = "";
	let processError: string | undefined;
	let parseErrors = 0;
	let timedOut = false;
	let aborted = false;
	let providerError: string | undefined;
	let exitCode = 1;

	const launch = await buildLaunch(input);
	const invocation = getPiInvocation(launch.args);
	exitCode = await new Promise<number>((resolve) => {
		const proc = spawnImpl(invocation.command, invocation.args, {
			cwd: launch.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...buildChildEnv(), ...launch.env },
		});
		proc.stdin.end();
		let settled = false;
		let terminating = false;
		let graceTimer: NodeJS.Timeout | undefined;
		let abortListener: (() => void) | undefined;
		let timeout: NodeJS.Timeout | undefined;
		let progressTimer: NodeJS.Timeout | undefined;
		let progressDirty = false;
		let lastProgressAt = 0;
		const progressIntervalMs = 50;
		const progressSnapshot = (): ProcessRunProgress => {
			const snapshot = progress.snapshot();
			return {
				output: snapshot.output,
				stderr,
				usage: snapshot.usage,
				events: snapshot.events,
				durationMs: Date.now() - start,
				...(snapshot.stopReason !== undefined ? { stopReason: snapshot.stopReason } : {}),
				...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
				parseErrors,
				wrote: snapshot.wrote,
			};
		};
		const emitProgress = () => {
			if (!progressDirty) return;
			progressDirty = false;
			lastProgressAt = Date.now();
			options.onUpdate?.(progressSnapshot());
		};
		const scheduleProgress = () => {
			progressDirty = true;
			const remaining = progressIntervalMs - (Date.now() - lastProgressAt);
			if (remaining <= 0) {
				if (progressTimer !== undefined) clearTimeout(progressTimer);
				progressTimer = undefined;
				emitProgress();
				return;
			}
			if (progressTimer === undefined) {
				progressTimer = setTimeout(() => {
					progressTimer = undefined;
					if (!settled) emitProgress();
				}, remaining);
			}
		};
		const flushProgress = () => {
			if (progressTimer !== undefined) clearTimeout(progressTimer);
			progressTimer = undefined;
			emitProgress();
		};
		const finish = (code: number) => {
			if (settled) return;
			if (stdoutBuffer.trim() !== "") processJsonLine(stdoutBuffer);
			flushProgress();
			settled = true;
			if (timeout !== undefined) clearTimeout(timeout);
			if (graceTimer !== undefined) clearTimeout(graceTimer);
			if (abortListener !== undefined) options.signal?.removeEventListener("abort", abortListener);
			resolve(code);
		};
		const abort = () => {
			aborted = true;
			terminateProcess(proc);
		};
		const terminateProcess = (procToKill: SpawnedProcess) => {
			if (terminating || settled) return;
			terminating = true;
			procToKill.kill("SIGTERM");
			if (settled || procToKill.exitCode !== null) return;
			graceTimer = setTimeout(() => {
				if (procToKill.exitCode === null) procToKill.kill("SIGKILL");
			}, 2_000);
		};
		timeout = setTimeout(() => {
			timedOut = true;
			terminateProcess(proc);
		}, input.timeoutMs);
		const processJsonLine = (line: string) => {
			if (line.trim() === "") return;
			const parsed = parseJsonObject(line);
			if (parsed === undefined) {
				parseErrors++;
				return;
			}
			if (progress.consume(parsed)) scheduleProgress();
		};

		proc.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split(/\r?\n/);
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processJsonLine(line);
		});
		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		proc.on("error", (spawnError) => {
			processError = spawnError.message;
			finish(1);
		});
		proc.on("close", (code) => finish(code ?? 0));
		if (options.signal !== undefined) {
			if (options.signal.aborted) abort();
			else {
				abortListener = abort;
				options.signal.addEventListener("abort", abortListener, { once: true });
			}
		}
	});
	const finalProgress = progress.snapshot();
	const finalError = processError ?? finalProgress.error;
	providerError = detectProviderError(stderr) ?? detectProviderError(finalError ?? "");
	return {
		exitCode,
		...(finalProgress.stopReason !== undefined ? { stopReason: finalProgress.stopReason } : {}),
		...(finalError !== undefined ? { error: finalError } : {}),
		output: finalProgress.output,
		stderr,
		usage: finalProgress.usage,
		events: finalProgress.events,
		durationMs: Date.now() - start,
		timedOut,
		aborted,
		...(providerError !== undefined ? { providerError } : {}),
		parseErrors,
		wrote: finalProgress.wrote,
	};
}

async function buildLaunch(input: ProcessRunInput): Promise<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }> {
	if (input.contextMode === "isolated") {
		const args = ["--mode", "json", "-p", "--no-session", "--system-prompt", input.agent.filePath];
		if (input.model !== undefined) args.push("--model", input.model);
		args.push("--tools", input.tools.join(","), `Task: ${input.task}`);
		return { args, cwd: input.cwd, env: { PI_SUBAGENT_CHILD: "1" } };
	}

	const fork = input.forkContext;
	const childSessionsRoot = path.join(path.dirname(fork.snapshotPath), "child-sessions");
	await mkdir(childSessionsRoot, { recursive: true, mode: 0o700 });
	const childSessionDir = await mkdtemp(path.join(childSessionsRoot, "attempt-"));
	const model = formatModelReference(fork.model);
	if (model === undefined) throw new Error("fork setup error: current model is unavailable");
	const args = [
		"--mode", "json", "-p",
		"--fork", fork.snapshotPath,
		"--session-dir", childSessionDir,
		"--session-id", fork.sessionId,
		"--model", model,
		"--thinking", fork.thinkingLevel,
		"--tools", fork.activeTools.join(","),
		input.assignment,
	];
	return {
		args,
		cwd: fork.cwd,
		env: {
			PI_SUBAGENT_CHILD: "1",
			PI_SUBAGENT_FORK: "1",
			PI_SUBAGENT_FORK_SYSTEM_PROMPT_FILE: fork.systemPromptPath,
			PI_SUBAGENT_FORK_MANIFEST: fork.manifestPath,
			PI_SUBAGENT_FORK_SNAPSHOT: fork.snapshotPath,
		},
	};
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript !== undefined && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function buildChildEnv(): NodeJS.ProcessEnv {
	const allowed = new Set(["PATH", "PATHEXT", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "TERM", "COLORTERM", "LANG", "LC_ALL"]);
	const prefixes = ["OPENAI_", "ANTHROPIC_", "OLLAMA_", "PI_", "NO_PROXY", "HTTP_PROXY", "HTTPS_PROXY"];
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (allowed.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) env[key] = value;
	}
	return env;
}

function detectProviderError(text: string): string | undefined {
	if (text.trim() === "") return undefined;
	const patterns = [/fork (?:setup error|context mismatch)/i, /model .*not.*found/i, /connection refused/i, /ECONNREFUSED/i, /rate.?limit/i, /provider error/i, /failed to load model/i];
	return patterns.some((pattern) => pattern.test(text)) ? text.trim() : undefined;
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(line) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}
