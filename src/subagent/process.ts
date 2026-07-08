import { spawn as nodeSpawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatSubagentSystemPrompt } from "../../agent/extensions/system-prompt.js";
import type { ProcessRunInput, ProcessRunOutput, ProcessRunProgress, RenderEvent, UsageStats } from "./types.js";

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
	const usage = emptyUsage();
	const events: RenderEvent[] = [];
	let tmpDir: string | undefined;
	let stdoutBuffer = "";
	let stderr = "";
	let output = "";
	let stopReason: string | undefined;
	let error: string | undefined;
	let model: string | undefined;
	let parseErrors = 0;
	let wrote = false;
	let timedOut = false;
	let aborted = false;
	let providerError: string | undefined;
	let exitCode = 1;

	try {
		const args = ["--mode", "json", "-p", "--no-session"];
		if (input.model !== undefined) args.push("--model", input.model);
		args.push("--tools", input.tools.join(","));
		if (input.agent.systemPrompt.trim() !== "") {
			tmpDir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
			const promptPath = path.join(tmpDir, `prompt-${sanitizeName(input.agent.name)}.md`);
			await writeFile(promptPath, formatSubagentSystemPrompt(input.agent), { encoding: "utf8", mode: 0o600 });
			args.push("--append-system-prompt", promptPath);
		}
		args.push(`Task: ${input.task}`);

		const invocation = getPiInvocation(args);
		exitCode = await new Promise<number>((resolve) => {
			const proc = spawnImpl(invocation.command, invocation.args, {
				cwd: input.cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...buildChildEnv(), PI_SUBAGENT_CHILD: "1" },
			});
			proc.stdin.end();
			let settled = false;
			let graceTimer: NodeJS.Timeout | undefined;
			const timeout = setTimeout(() => {
				timedOut = true;
				terminateProcess(proc);
			}, input.timeoutMs);
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (graceTimer !== undefined) clearTimeout(graceTimer);
				if (stdoutBuffer.trim() !== "") processJsonLine(stdoutBuffer);
				resolve(code);
			};
			const abort = () => {
				aborted = true;
				terminateProcess(proc);
			};
			const terminateProcess = (procToKill: SpawnedProcess) => {
				procToKill.kill("SIGTERM");
				graceTimer = setTimeout(() => {
					if (procToKill.exitCode === null) procToKill.kill("SIGKILL");
				}, 2_000);
			};
			const processJsonLine = (line: string) => {
				if (line.trim() === "") return;
				const parsed = parseJsonObject(line);
				if (parsed === undefined) {
					parseErrors++;
					return;
				}
				const type = stringField(parsed, "type");
				if (type === "message_end") {
					const message = recordField(parsed, "message");
					if (message !== undefined) handleMessage(message);
				} else if (type === "tool_result_end") {
					const message = recordField(parsed, "message");
					if (message !== undefined) handleToolMessage(message);
				}
			};
			const emitProgress = () => {
				options.onUpdate?.({
					output,
					stderr,
					usage: { ...usage },
					events: events.map((event) => ({ ...event })),
					durationMs: Date.now() - start,
					...(stopReason !== undefined ? { stopReason } : {}),
					...(error !== undefined ? { error } : {}),
					parseErrors,
					wrote,
				});
			};
			const handleMessage = (message: Record<string, unknown>) => {
				if (stringField(message, "role") !== "assistant") return;
				usage.turns++;
				const messageModel = stringField(message, "model");
				if (messageModel !== undefined) model = messageModel;
				const reason = stringField(message, "stopReason");
				if (reason !== undefined) stopReason = reason;
				const errorMessage = stringField(message, "errorMessage");
				if (errorMessage !== undefined) error = errorMessage;
				mergeUsage(usage, recordField(message, "usage"));
				for (const part of contentParts(message)) {
					if (stringField(part, "type") === "text") {
						const text = stringField(part, "text");
						if (text !== undefined) {
							output = text;
							events.push({ type: "text", text });
						}
					} else if (stringField(part, "type") === "toolCall") {
						const name = stringField(part, "name") ?? "tool";
						const args = recordField(part, "arguments") ?? {};
						if (name === "write" || name === "edit" || name === "bash") wrote = true;
						events.push({ type: "tool", name, args });
					}
				}
				emitProgress();
			};
			const handleToolMessage = (message: Record<string, unknown>) => {
				for (const part of contentParts(message)) {
					if (stringField(part, "type") === "toolResult") {
						const name = stringField(part, "name");
						if (name === "write" || name === "edit" || name === "bash") wrote = true;
					}
				}
				emitProgress();
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
				error = spawnError.message;
				finish(1);
			});
			proc.on("close", (code) => finish(code ?? 0));
			if (options.signal !== undefined) {
				if (options.signal.aborted) abort();
				else options.signal.addEventListener("abort", abort, { once: true });
			}
		});
		providerError = detectProviderError(stderr) ?? detectProviderError(error ?? "");
		return {
			exitCode,
			...(stopReason !== undefined ? { stopReason } : {}),
			...(error !== undefined ? { error } : {}),
			output,
			stderr,
			usage,
			events,
			durationMs: Date.now() - start,
			timedOut,
			aborted,
			...(providerError !== undefined ? { providerError } : {}),
			parseErrors,
			wrote,
		};
	} finally {
		if (tmpDir !== undefined) await rm(tmpDir, { recursive: true, force: true });
		void model;
	}
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
	const patterns = [/model .*not.*found/i, /connection refused/i, /ECONNREFUSED/i, /rate.?limit/i, /provider error/i, /failed to load model/i];
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

function contentParts(message: Record<string, unknown>): Record<string, unknown>[] {
	const content = message["content"];
	if (!Array.isArray(content)) return [];
	return content.filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null && !Array.isArray(part));
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
	const value = record[key];
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function mergeUsage(target: UsageStats, usage: Record<string, unknown> | undefined): void {
	if (usage === undefined) return;
	target.input += numberField(usage, "input");
	target.output += numberField(usage, "output");
	target.cacheRead += numberField(usage, "cacheRead");
	target.cacheWrite += numberField(usage, "cacheWrite");
	target.contextTokens = Math.max(target.contextTokens, numberField(usage, "totalTokens"));
	const cost = recordField(usage, "cost");
	const total = cost === undefined ? 0 : numberField(cost, "total");
	if (total > 0) target.cost = (target.cost ?? 0) + total;
}

function numberField(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 0 };
}

function sanitizeName(name: string): string {
	return name.replace(/[^\w.-]+/g, "_");
}
