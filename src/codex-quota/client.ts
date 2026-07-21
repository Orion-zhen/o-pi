import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { CodexQuotaError, type CodexQuotaBucket, type CodexQuotaSnapshot, type CodexQuotaWindow, type CodexResetCredit } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND = "codex";
const APP_SERVER_ARGS = ["app-server", "--stdio"] as const;

export interface CodexQuotaClientOptions {
	command?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	now?: Date;
	spawnImpl?: SpawnFunction;
}

type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

/** 通过 Codex app-server 的 account/rateLimits/read 读取额度和重置卡。 */
export async function collectCodexQuotaSnapshot(options: CodexQuotaClientOptions = {}): Promise<CodexQuotaSnapshot> {
	const process = startAppServer(options);
	const timeout = createTimeout(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	let nextId = 1;
	try {
		const initializeId = nextId++;
		writeRequest(process, initializeId, "initialize", {
			clientInfo: { name: "o-pi", title: "o-pi quota", version: "1.0.0" },
			capabilities: null,
		});
		await waitForResponse(process, initializeId, timeout.signal);

		const rateLimitsId = nextId++;
		writeRequest(process, rateLimitsId, "account/rateLimits/read", {});
		const response = await waitForResponse(process, rateLimitsId, timeout.signal);
		return parseCodexQuotaSnapshot(response, options.now ?? new Date());
	} catch (error) {
		if (timeout.signal.aborted) {
			throw new CodexQuotaError(options.signal?.aborted ? "aborted" : "timeout", options.signal?.aborted ? "Quota request was cancelled." : "Quota request timed out.");
		}
		if (error instanceof CodexQuotaError) throw error;
		throw new CodexQuotaError("process_failed", "Codex app-server request failed.");
	} finally {
		timeout.dispose();
		terminate(process);
	}
}

/** 解析 app-server 的 JSON-RPC result；仅在进程边界调用，避免 UI 依赖未稳定的生成类型。 */
export function parseCodexQuotaSnapshot(value: unknown, now = new Date()): CodexQuotaSnapshot {
	if (!isRecord(value)) throw new CodexQuotaError("unexpected_response", "Codex app-server returned an unexpected response.");
	const rawRateLimits = value.rateLimits;
	if (!isRecord(rawRateLimits)) throw new CodexQuotaError("unexpected_response", "Codex app-server returned no rate limits.");

	const buckets: CodexQuotaBucket[] = [];
	const byLimitId = value.rateLimitsByLimitId;
	if (isRecord(byLimitId)) {
		for (const [key, rawBucket] of Object.entries(byLimitId)) {
			if (!isRecord(rawBucket)) continue;
			buckets.push(parseBucket(rawBucket, key));
		}
	}
	if (buckets.length === 0) buckets.push(parseBucket(rawRateLimits, "codex"));
	buckets.sort((left, right) => (left.id === "codex" ? -1 : right.id === "codex" ? 1 : 0));

	return {
		generatedAt: now,
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
		buckets,
		resetCredits: parseResetCredits(value.rateLimitResetCredits),
	};
}

function startAppServer(options: CodexQuotaClientOptions): ChildProcessWithoutNullStreams {
	const command = options.command ?? DEFAULT_COMMAND;
	try {
		const process = (options.spawnImpl ?? spawn)(command, APP_SERVER_ARGS, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
		return process;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) throw new CodexQuotaError("command_not_found", "Codex command was not found.");
		throw new CodexQuotaError("startup_failed", "Codex app-server could not be started.");
	}
}

function writeRequest(process: ChildProcessWithoutNullStreams, id: number, method: string, params: Record<string, unknown>): void {
	try {
		process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	} catch {
		throw new CodexQuotaError("process_failed", "Codex app-server request could not be written.");
	}
}

async function waitForResponse(process: ChildProcessWithoutNullStreams, id: number, signal: AbortSignal): Promise<unknown> {
	return new Promise<unknown>((resolve, reject) => {
		let buffer = "";
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			process.stdout.off("data", onData);
			process.off("error", onError);
			process.off("close", onClose);
			signal.removeEventListener("abort", onAbort);
			callback();
		};
		const onData = (chunk: Buffer | string): void => {
			buffer += chunk.toString();
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line.trim() === "") continue;
				let message: unknown;
				try {
					message = JSON.parse(line) as unknown;
				} catch {
					finish(() => reject(new CodexQuotaError("protocol_error", "Codex app-server returned invalid JSON.")));
					return;
				}
				if (!isRecord(message) || message.id !== id) continue;
				if (isRecord(message.error)) {
					finish(() => reject(new CodexQuotaError("server_error", "Codex app-server rejected the quota request.")));
					return;
				}
				if (!("result" in message)) {
					finish(() => reject(new CodexQuotaError("protocol_error", "Codex app-server returned an invalid response.")));
					return;
				}
				finish(() => resolve(message.result));
				return;
			}
		};
		const onError = (error: Error): void => {
			finish(() => reject(isNodeError(error, "ENOENT") ? new CodexQuotaError("command_not_found", "Codex command was not found.") : new CodexQuotaError("process_failed", "Codex app-server stopped unexpectedly.")));
		};
		const onClose = (): void => {
			finish(() => reject(new CodexQuotaError("process_failed", "Codex app-server stopped unexpectedly.")));
		};
		const onAbort = (): void => {
			finish(() => reject(new CodexQuotaError("aborted", "Quota request was cancelled.")));
		};
		process.stdout.on("data", onData);
		process.once("error", onError);
		process.once("close", onClose);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

function parseBucket(value: Record<string, unknown>, fallbackId: string): CodexQuotaBucket {
	return {
		id: stringOrUndefined(value.limitId) ?? fallbackId,
		name: stringOrUndefined(value.limitName),
		planType: stringOrUndefined(value.planType),
		primary: parseWindow(value.primary),
		secondary: parseWindow(value.secondary),
		credits: parseCredits(value.credits),
	};
}

function parseWindow(value: unknown): CodexQuotaWindow | undefined {
	if (!isRecord(value)) return undefined;
	return {
		usedPercent: finiteNumber(value.usedPercent),
		windowDurationMins: finiteNumber(value.windowDurationMins),
		resetsAt: parseUnixDate(value.resetsAt),
	};
}

function parseCredits(value: unknown): CodexQuotaBucket["credits"] {
	if (!isRecord(value)) return undefined;
	return {
		hasCredits: value.hasCredits === true,
		unlimited: value.unlimited === true,
		balance: stringOrUndefined(value.balance),
	};
}

function parseResetCredits(value: unknown): CodexQuotaSnapshot["resetCredits"] {
	if (!isRecord(value)) return undefined;
	const availableCount = parseCount(value.availableCount);
	if (availableCount === undefined) throw new CodexQuotaError("unexpected_response", "Codex app-server returned invalid reset credits.");
	if (value.credits === null || value.credits === undefined) return { availableCount, credits: undefined };
	if (!Array.isArray(value.credits)) throw new CodexQuotaError("unexpected_response", "Codex app-server returned invalid reset credits.");
	return { availableCount, credits: value.credits.filter(isRecord).map(parseResetCredit) };
}

function parseResetCredit(value: Record<string, unknown>): CodexResetCredit {
	const id = stringOrUndefined(value.id);
	if (id === undefined) throw new CodexQuotaError("unexpected_response", "Codex app-server returned an invalid reset credit.");
	return {
		id,
		resetType: stringOrUndefined(value.resetType) ?? "unknown",
		status: stringOrUndefined(value.status) ?? "unknown",
		grantedAt: parseUnixDate(value.grantedAt),
		expiresAt: parseUnixDate(value.expiresAt),
		title: stringOrUndefined(value.title),
		description: stringOrUndefined(value.description),
	};
}

function parseUnixDate(value: unknown): Date | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const date = new Date(value * 1_000);
	return Number.isFinite(date.getTime()) ? date : undefined;
}

function parseCount(value: unknown): number | undefined {
	const count = typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined;
	return count !== undefined && Number.isInteger(count) && count >= 0 ? count : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function createTimeout(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort(parent?.reason);
	if (parent?.aborted) onAbort();
	else parent?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
		},
	};
}

function terminate(process: ChildProcessWithoutNullStreams): void {
	if (process.exitCode !== null) return;
	try {
		process.kill("SIGTERM");
	} catch {
		// The process may have exited between the check and kill.
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown, code: string): boolean {
	return isRecord(value) && value.code === code;
}
