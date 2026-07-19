import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, createLocalBashOperations } from "@earendil-works/pi-coding-agent";

import { checkDeniedText, type PatternDenyMatch } from "../safety/pattern-guard.js";
import { OutputCapture } from "./output-capture.js";
import { cleanForModel, createBashOutputView } from "./output-view.js";
import type { BashExecutionResult, BashParams, ExecuteBashRuntime } from "./types.js";

const UPDATE_THROTTLE_MS = 100;
const PYTHON_VIRTUAL_ENV_DIRS = [".venv", "venv", "env", ".env", "pyvenv", "pyenv", ".pyvenv", ".pyenv"] as const;

interface PythonVirtualEnvironment {
	root: string;
	bin: string;
}

/** 执行模型提供的 shell 命令；自动将 Windows 反斜杠路径转为正斜杠。 */
export async function executeBashCommand(params: BashParams, runtime: ExecuteBashRuntime): Promise<BashExecutionResult> {
	validateParams(params, runtime.config.default_timeout_seconds);
	const denied = checkDeniedText(params.command, runtime.config.safety);
	if (denied !== null) return blockedCommandResult(denied);
	params = { ...params, command: normalizeWindowsPath(params.command) };
	const pythonVirtualEnv = await resolvePythonVirtualEnvironment(runtime.cwd);
	const executionEnv = pythonVirtualEnv === undefined ? undefined : virtualEnvironmentVariables(pythonVirtualEnv);
	const timeoutSeconds = params.timeout ?? runtime.config.default_timeout_seconds;
	const startedAt = runtime.now?.() ?? Date.now();
	const capture = await OutputCapture.create({
		sessionId: runtime.sessionId,
		toolCallId: runtime.toolCallId,
		maxCaptureBytes: runtime.config.limits.max_capture_bytes,
		previewBytes: Math.max(runtime.config.limits.failure_output_bytes * 4, runtime.config.limits.live_output_bytes * 2),
	});

	const controller = new AbortController();
	let stopReason: "timeout" | "aborted" | undefined;
	let updateTimer: NodeJS.Timeout | undefined;
	let updateDirty = false;
	let lastUpdateAt = 0;
	let acceptingUpdates = true;

	const abortFromUser = () => {
		stopReason = "aborted";
		controller.abort();
	};
	if (runtime.signal?.aborted) abortFromUser();
	runtime.signal?.addEventListener("abort", abortFromUser, { once: true });

	const timeoutTimer = setTimeout(() => {
		stopReason = "timeout";
		controller.abort();
	}, timeoutSeconds * 1000);

	const emitUpdate = () => {
		if (!runtime.onUpdate || !updateDirty || !acceptingUpdates) return;
		updateDirty = false;
		lastUpdateAt = runtime.now?.() ?? Date.now();
		const elapsed = lastUpdateAt - startedAt;
		const live = cleanForModel(capture.liveText(runtime.config.limits.live_output_bytes), "text").text;
		runtime.onUpdate({
			content: `[running ${(elapsed / 1000).toFixed(1)}s]${live ? `\n\n${live}` : ""}`,
			details: {
				status: "exited",
				duration_ms: elapsed,
				output_state: "complete",
				output_format: "text",
				total_lines: 0,
				returned_lines: 0,
				total_bytes: 0,
				returned_bytes: 0,
				capture_complete: true,
			},
		});
	};
	const clearUpdateTimer = () => {
		if (updateTimer !== undefined) {
			clearTimeout(updateTimer);
			updateTimer = undefined;
		}
	};
	const scheduleUpdate = () => {
		if (!runtime.onUpdate || !acceptingUpdates) return;
		updateDirty = true;
		const now = runtime.now?.() ?? Date.now();
		const delay = UPDATE_THROTTLE_MS - (now - lastUpdateAt);
		if (delay <= 0) {
			clearUpdateTimer();
			emitUpdate();
			return;
		}
		updateTimer ??= setTimeout(() => {
			updateTimer = undefined;
			emitUpdate();
		}, delay);
	};

	let exitCode: number | undefined;
	let status: "exited" | "timed_out" | "aborted" = "exited";
	let operationError: unknown;
	try {
		const result = await runtime.operations.exec(params.command, runtime.cwd, {
			onData(data) {
				capture.append(data);
				scheduleUpdate();
			},
			signal: controller.signal,
			...(executionEnv !== undefined ? { env: executionEnv } : {}),
		});
		exitCode = result.exitCode ?? undefined;
	} catch (error) {
		operationError = error;
		if (stopReason === "timeout") status = "timed_out";
		else if (stopReason === "aborted" || controller.signal.aborted) status = "aborted";
	} finally {
		acceptingUpdates = false;
		clearUpdateTimer();
		clearTimeout(timeoutTimer);
		runtime.signal?.removeEventListener("abort", abortFromUser);
	}

	if (operationError !== undefined && status === "exited") throw operationError;
	const captured = await capture.finish();
	const durationMs = (runtime.now?.() ?? Date.now()) - startedAt;
	const view = createBashOutputView({
		text: captured.previewText,
		status,
		...(exitCode !== undefined ? { exitCode } : {}),
		durationMs,
		totalBytes: captured.totalBytes,
		totalLines: captured.totalLines,
		fullOutputPath: captured.logPath,
		captureComplete: captured.captureComplete,
		binary: captured.binary,
		limits: runtime.config.limits,
	});
	if (!view.keepLog) await capture.deleteLog();
	return { content: view.content, details: view.details };
}

function blockedCommandResult(match: PatternDenyMatch): BashExecutionResult {
	return {
		content: [
			'<error tool="bash" code="BLOCKED_COMMAND">',
			"Command blocked by bash-tool safety deny rule.",
			`Matched ${match.kind}: ${escapeXmlText(match.rule)}`,
			"</error>",
		].join("\n"),
		details: {
			status: "exited",
			duration_ms: 0,
			output_state: "complete",
			output_format: "text",
			total_lines: 0,
			returned_lines: 0,
			total_bytes: 0,
			returned_bytes: 0,
			capture_complete: true,
		},
	};
}

export function createDefaultBashOperations() {
	return createLocalBashOperations();
}

/** 检测工作目录中的常见 Python 虚拟环境；要求标准标记和可执行的 python 入口。 */
async function resolvePythonVirtualEnvironment(cwd: string): Promise<PythonVirtualEnvironment | undefined> {
	const scriptsDir = process.platform === "win32" ? "Scripts" : "bin";
	const interpreter = process.platform === "win32" ? "python.exe" : "python";
	for (const directory of PYTHON_VIRTUAL_ENV_DIRS) {
		const root = path.join(cwd, directory);
		if (!(await hasVirtualEnvironmentMarker(root))) continue;
		const bin = path.join(root, scriptsDir);
		try {
			const interpreterStat = await stat(path.join(bin, interpreter));
			if (!interpreterStat.isFile()) continue;
			await access(path.join(bin, interpreter), constants.X_OK);
			return { root, bin };
		} catch {
			// 继续检查下一个常见目录。
		}
	}
	return undefined;
}

async function hasVirtualEnvironmentMarker(root: string): Promise<boolean> {
	try {
		return (await stat(path.join(root, "pyvenv.cfg"))).isFile();
	} catch {
		return false;
	}
}

/** 模拟 activate，并保留 Pi 默认放在 PATH 中的托管二进制目录。 */
function virtualEnvironmentVariables(virtualEnv: PythonVirtualEnvironment): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	const pathKey = environmentKey(env, "PATH");
	const currentPath = env[pathKey] ?? "";
	const managedBin = resolvePiManagedBin();
	const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
	const basePath = pathEntries.some((entry) => samePath(entry, managedBin))
		? currentPath
		: [managedBin, currentPath].filter(Boolean).join(path.delimiter);
	env[pathKey] = [virtualEnv.bin, basePath].filter(Boolean).join(path.delimiter);

	deleteEnvironmentVariable(env, "PYTHONHOME");
	deleteEnvironmentVariable(env, "VIRTUAL_ENV");
	deleteEnvironmentVariable(env, "PIP_REQUIRE_VIRTUALENV");
	env.VIRTUAL_ENV = virtualEnv.root;
	// 没有安装 pip 的 venv 也不能向后回退并修改全局环境。
	env.PIP_REQUIRE_VIRTUALENV = "1";
	return env;
}

function resolvePiManagedBin(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "bin");
	let agentDir = configured;
	if (agentDir === "~") agentDir = os.homedir();
	else if (agentDir.startsWith("~/") || (process.platform === "win32" && agentDir.startsWith("~\\"))) {
		agentDir = path.join(os.homedir(), agentDir.slice(2));
	} else if (/^file:\/\//.test(agentDir)) {
		agentDir = fileURLToPath(agentDir);
	}
	return path.join(agentDir, "bin");
}

function environmentKey(env: NodeJS.ProcessEnv, name: string): string {
	if (process.platform !== "win32") return name;
	return Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase()) ?? name;
}

function deleteEnvironmentVariable(env: NodeJS.ProcessEnv, name: string): void {
	if (process.platform !== "win32") {
		delete env[name];
		return;
	}
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() === name.toLowerCase()) delete env[key];
	}
}

function samePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** 轻量 Windows 路径兼容：仅在 Windows 上将反斜杠替换为正斜杠，保留常见转义序列。 */
export function normalizeWindowsPath(cmd: string, platform?: string): string {
	if ((platform ?? process.platform) !== "win32") return cmd;
	// 保留常见转义序列：\n \t \r \\ \" \' \$ \` \b \f \v
	return cmd.replace(/\\(?![ntr\\"'$`bfv])/g, "/");
}

function validateParams(params: BashParams, defaultTimeout: number): void {
	if (typeof params.command !== "string") throw new Error("bash command must be a string.");
	const timeout = params.timeout ?? defaultTimeout;
	if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86_400) {
		throw new Error("bash timeout must be a finite number of seconds between 1 and 86400.");
	}
}

function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
