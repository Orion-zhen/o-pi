import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { hostServices, type AgentProcess } from "../runtime/host-services.ts";
import { childInvocation } from "../runtime/invocation.ts";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { PiJsonProgressAccumulator, type PiJsonProgressSnapshot } from "./json-progress.ts";
import { formatModelReference } from "./model.ts";
import type { ProcessOutcome, ProcessRunInput, ProcessRunOutput, ProcessRunProgress } from "./types.ts";

export async function runPiProcess(input: ProcessRunInput, options: { signal?: AbortSignal; onUpdate?: (progress: ProcessRunProgress) => void } = {}): Promise<ProcessRunOutput> {
	const start = Date.now();
	const progress = new PiJsonProgressAccumulator();
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	let stdoutBuffer = "";
	let stderr = "";
	let processError: string | undefined;
	let parseErrors = 0;
	let termination: "timeout" | "aborted" | undefined;

	const launch = await buildLaunch(input);
	const invocation = childInvocation(launch.args);
	const exitCode = await new Promise<number>((resolve, reject) => {
		const env = { ...buildChildEnv(invocation.env ?? process.env), ...launch.env };
		const proc: AgentProcess = hostServices
			? hostServices.spawnAgent(launch.args, launch.cwd, env)
			: spawn(invocation.command, invocation.args, {
				cwd: launch.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env,
			});
		let settled = false;
		let terminating = false;
		let progressError: { error: unknown } | undefined;
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
			if (!progressDirty || progressError !== undefined) return;
			progressDirty = false;
			lastProgressAt = Date.now();
			try { options.onUpdate?.(progressSnapshot()); }
			catch (error) {
				progressError = { error };
				terminateProcess();
			}
		};
		const scheduleProgress = () => {
			if (options.onUpdate === undefined) return;
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
			settled = true;
			stdoutBuffer += stdoutDecoder.end();
			stderr += stderrDecoder.end();
			if (stdoutBuffer.trim() !== "") processJsonLine(stdoutBuffer);
			flushProgress();
			if (timeout !== undefined) clearTimeout(timeout);
			if (graceTimer !== undefined) clearTimeout(graceTimer);
			if (abortListener !== undefined) options.signal?.removeEventListener("abort", abortListener);
			proc.stdout.off("data", onStdout);
			proc.stderr.off("data", onStderr);
			proc.off("error", onError);
			proc.off("close", onClose);
			if (progressError === undefined) resolve(code);
			else reject(progressError.error);
		};
		const abort = () => terminateProcess("aborted");
		const terminateProcess = (reason?: "timeout" | "aborted") => {
			if (terminating || settled) return;
			terminating = true;
			termination = reason;
			proc.kill("SIGTERM");
			if (settled || proc.exitCode !== null) return;
			graceTimer = setTimeout(() => {
				if (proc.exitCode === null) proc.kill("SIGKILL");
			}, 2_000);
		};
		const processJsonLine = (line: string) => {
			if (progressError !== undefined || line.trim() === "") return;
			let changed: boolean;
			try {
				changed = progress.consume(parseJsonEvent(line));
			} catch {
				parseErrors++;
				return;
			}
			if (changed) scheduleProgress();
		};
		const onStdout = (chunk: Buffer) => {
			stdoutBuffer += stdoutDecoder.write(chunk);
			const lines = stdoutBuffer.split(/\r?\n/);
			stdoutBuffer = lines.pop() as string;
			for (const line of lines) processJsonLine(line);
		};
		const onStderr = (chunk: Buffer) => { stderr += stderrDecoder.write(chunk); };
		const onError = (error: Error) => { processError = error.message; };
		const onClose = (code: number | null) => finish(code === null ? 1 : code);

		timeout = setTimeout(() => terminateProcess("timeout"), input.timeoutMs);
		proc.stdout.on("data", onStdout);
		proc.stderr.on("data", onStderr);
		proc.on("error", onError);
		proc.on("close", onClose);
		if (options.signal !== undefined) {
			if (options.signal.aborted) abort();
			else {
				abortListener = abort;
				options.signal.addEventListener("abort", abortListener, { once: true });
			}
		}
	});
	const finalProgress = progress.snapshot();
	return {
		exitCode,
		...(finalProgress.stopReason !== undefined ? { stopReason: finalProgress.stopReason } : {}),
		outcome: processOutcome(finalProgress, exitCode, termination, processError, parseErrors),
		output: finalProgress.output,
		stderr,
		usage: finalProgress.usage,
		events: finalProgress.events,
		durationMs: Date.now() - start,
		wrote: finalProgress.wrote,
	};
}

function processOutcome(
	progress: PiJsonProgressSnapshot,
	exitCode: number,
	termination: "timeout" | "aborted" | undefined,
	processError: string | undefined,
	parseErrors: number,
): ProcessOutcome {
	if (termination === "aborted" || progress.stopReason === "aborted") {
		return { kind: "failed", reason: "aborted", message: "subagent aborted" };
	}
	if (parseErrors > 0) return {
		kind: "failed", reason: "protocol",
		message: `Pi JSON protocol error: ${parseErrors} malformed event${parseErrors === 1 ? "" : "s"}`,
	};
	if (progress.stopReason === "length") return {
		kind: "failed", reason: "length", message: "subagent output truncated: model output token limit reached",
	};
	if (termination === "timeout") return { kind: "failed", reason: "timeout", message: "subagent timed out" };
	if (processError !== undefined) return { kind: "failed", reason: "process", message: processError };
	if (progress.error !== undefined) return { kind: "failed", reason: "model", message: progress.error };
	if (exitCode !== 0) return { kind: "failed", reason: "exit", message: `subagent exited with code ${exitCode}` };
	if (progress.stopReason === "error") return { kind: "failed", reason: "model", message: "subagent stopReason: error" };
	if (progress.output.trim() === "") return { kind: "failed", reason: "empty", message: "empty output" };
	return { kind: "success" };
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
	const childSessionDir = await mkdtemp(path.join(childSessionsRoot, "run-"));
	const args = [
		"--mode", "json", "-p",
		"--fork", fork.snapshotPath,
		"--session-dir", childSessionDir,
		"--session-id", fork.sessionId,
		"--model", formatModelReference(fork.model),
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
		},
	};
}

function buildChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const allowed = new Set(["ELECTRON_RUN_AS_NODE", "PATH", "PATHEXT", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "TERM", "COLORTERM", "LANG", "LC_ALL"]);
	const prefixes = ["OPENAI_", "ANTHROPIC_", "OLLAMA_", "PI_", "NO_PROXY", "HTTP_PROXY", "HTTPS_PROXY"];
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (allowed.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) env[key] = value;
	}
	return env;
}

function parseJsonEvent(line: string): JsonAgentSessionEvent {
	const value: unknown = JSON.parse(line);
	if (typeof value !== "object" || value === null || Array.isArray(value) || typeof Reflect.get(value, "type") !== "string") {
		throw new Error("Pi JSON event must be an object with a type");
	}
	return value as JsonAgentSessionEvent;
}
