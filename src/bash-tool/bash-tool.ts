import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { resolveBashSkillPaths } from "./skill-paths.js";
import { OutputCapture } from "./output-capture.js";
import { cleanForModel, createBashOutputView } from "./output-view.js";
import type {
	BashEnvironmentConfig,
	BashExecutionResult,
	BashParams,
	BashSessionMetadata,
	CapturedOutput,
	ExecuteBashRuntime,
} from "./types.js";

const UPDATE_THROTTLE_MS = 100;

export interface PythonVirtualEnvironment {
	root: string;
	bin: string;
}

export interface PythonVirtualEnvironmentFileSystem {
	stat(target: string): Promise<{ isFile(): boolean }>;
	access(target: string, mode: number): Promise<void>;
}

const nodePythonVirtualEnvironmentFileSystem: PythonVirtualEnvironmentFileSystem = {
	stat: async (target) => stat(target),
	access: async (target, mode) => access(target, mode),
};

/** 执行模型提供的 shell 命令。 */
export async function executeBashCommand(params: BashParams, runtime: ExecuteBashRuntime): Promise<BashExecutionResult> {
	const skillPaths = await resolveBashSkillPaths(params.command, runtime.branch, runtime.signal);
	if (skillPaths.kind === "error") return skillResourceErrorResult(skillPaths);
	params = { ...params, command: skillPaths.command };
	const pythonVirtualEnv = await resolvePythonVirtualEnvironment(runtime.cwd, runtime.config.python_venv_paths);
	const baseEnvironment = createBashEnvironment(runtime.session, runtime.config.environment);
	const executionEnv = pythonVirtualEnv === undefined
		? baseEnvironment
		: virtualEnvironmentVariables(baseEnvironment, pythonVirtualEnv);
	const timeoutSeconds = params.timeout ?? runtime.config.default_timeout_seconds;
	const startedAt = Date.now();
	const capture = await OutputCapture.create({
		sessionId: runtime.session.sessionId,
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

	const stop = (reason: "timeout" | "aborted") => {
		if (controller.signal.aborted) return;
		stopReason = reason;
		controller.abort();
	};
	const abortFromUser = () => stop("aborted");
	if (runtime.signal?.aborted) abortFromUser();
	runtime.signal?.addEventListener("abort", abortFromUser, { once: true });

	const timeoutTimer = setTimeout(() => stop("timeout"), timeoutSeconds * 1000);

	const emitUpdate = () => {
		if (!runtime.onUpdate || !updateDirty || !acceptingUpdates) return;
		updateDirty = false;
		lastUpdateAt = Date.now();
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
		const now = Date.now();
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
	let operationFailure: { error: unknown } | undefined;
	try {
		const result = await runtime.operations.exec(params.command, runtime.cwd, {
			onData(data) {
				capture.append(data);
				scheduleUpdate();
			},
			signal: controller.signal,
			env: executionEnv,
		});
		exitCode = result.exitCode ?? undefined;
	} catch (error) {
		operationFailure = { error };
	} finally {
		acceptingUpdates = false;
		clearUpdateTimer();
		clearTimeout(timeoutTimer);
		runtime.signal?.removeEventListener("abort", abortFromUser);
	}
	const status = stopReason === "timeout" ? "timed_out" : stopReason === "aborted" ? "aborted" : "exited";

	let captured: CapturedOutput;
	try {
		captured = await capture.finish();
	} catch (captureError) {
		await capture.deleteLog().catch(() => undefined);
		if (operationFailure !== undefined && status === "exited") throw operationFailure.error;
		throw captureError;
	}
	if (operationFailure !== undefined && status === "exited") {
		await capture.deleteLog().catch(() => undefined);
		throw operationFailure.error;
	}
	const durationMs = Date.now() - startedAt;
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

function skillResourceErrorResult(error: { code: "invalid-locator" | "access-denied"; message: string; path: string }): BashExecutionResult {
	const code = error.code === "invalid-locator" ? "INVALID_SKILL_RESOURCE" : "SKILL_RESOURCE_ACCESS_DENIED";
	return {
		content: [
			`<error tool="bash" code="${code}">`,
			escapeXmlText(error.message),
			`Path: ${escapeXmlText(error.path)}`,
			"</error>",
		].join("\n"),
		details: {
			status: "exited",
			exit_code: 126,
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

/** 并行检测配置的 Python 虚拟环境，并按路径顺序选择首个有效项。 */
export async function resolvePythonVirtualEnvironment(
	cwd: string,
	configuredPaths: readonly string[],
	fileSystem: PythonVirtualEnvironmentFileSystem = nodePythonVirtualEnvironmentFileSystem,
): Promise<PythonVirtualEnvironment | undefined> {
	const scriptsDir = process.platform === "win32" ? "Scripts" : "bin";
	const interpreter = process.platform === "win32" ? "python.exe" : "python";
	const probes = configuredPaths.map(async (configuredPath): Promise<PythonVirtualEnvironment | undefined> => {
		const root = path.resolve(cwd, configuredPath);
		const bin = path.join(root, scriptsDir);
		try {
			const markerStat = await fileSystem.stat(path.join(root, "pyvenv.cfg"));
			if (!markerStat.isFile()) return undefined;
			const interpreterPath = path.join(bin, interpreter);
			const interpreterStat = await fileSystem.stat(interpreterPath);
			if (!interpreterStat.isFile()) return undefined;
			await fileSystem.access(interpreterPath, constants.X_OK);
			return { root, bin };
		} catch {
			return undefined;
		}
	});
	for (const probe of probes) {
		const candidate = await probe;
		if (candidate !== undefined) return candidate;
	}
	return undefined;
}

/** 按显式继承策略构造 shell 环境，并只暴露允许的当前会话 PI_* 元数据。 */
export function createBashEnvironment(session: BashSessionMetadata, config: BashEnvironmentConfig): NodeJS.ProcessEnv {
	const flags = process.platform === "win32" ? "iu" : "u";
	const deniedNames = config.remove_name_regex.map((rule) => new RegExp(rule, flags));
	const env: NodeJS.ProcessEnv = {};
	if (config.inherit) {
		for (const [name, value] of Object.entries(process.env)) {
			if (!deniedNames.some((rule) => rule.test(name))) env[name] = value;
		}
	}
	const pathKey = environmentKey(env, "PATH");
	const currentPath = env[pathKey] ?? "";
	const managedBin = resolvePiManagedBin();
	const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
	if (!pathEntries.some((entry) => samePath(entry, managedBin))) {
		env[pathKey] = [managedBin, currentPath].filter(Boolean).join(path.delimiter);
	}

	for (const name of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
		deleteEnvironmentVariable(env, name);
	}
	setEnvironmentVariable(env, "PI_SESSION_ID", session.sessionId);
	if (config.expose_pi_session_file) setEnvironmentVariable(env, "PI_SESSION_FILE", session.sessionFile);
	setEnvironmentVariable(env, "PI_PROVIDER", session.provider);
	setEnvironmentVariable(env, "PI_MODEL", session.model);
	setEnvironmentVariable(env, "PI_REASONING_LEVEL", session.reasoningLevel);
	return env;
}

/** 模拟 activate，并保留 Pi 默认放在 PATH 中的托管二进制目录。 */
function virtualEnvironmentVariables(baseEnvironment: NodeJS.ProcessEnv, virtualEnv: PythonVirtualEnvironment): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...baseEnvironment };
	const pathKey = environmentKey(env, "PATH");
	const currentPath = env[pathKey] ?? "";
	env[pathKey] = [virtualEnv.bin, currentPath].filter(Boolean).join(path.delimiter);

	deleteEnvironmentVariable(env, "PYTHONHOME");
	deleteEnvironmentVariable(env, "VIRTUAL_ENV");
	deleteEnvironmentVariable(env, "PIP_REQUIRE_VIRTUALENV");
	setEnvironmentVariable(env, "VIRTUAL_ENV", virtualEnv.root);
	// 没有安装 pip 的 venv 也不能向后回退并修改全局环境。
	setEnvironmentVariable(env, "PIP_REQUIRE_VIRTUALENV", "1");
	return env;
}

function resolvePiManagedBin(): string {
	return path.join(getAgentDir(), "bin");
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

function setEnvironmentVariable(env: NodeJS.ProcessEnv, name: string, value: string | undefined): void {
	if (value === undefined) return;
	const key = environmentKey(env, name);
	env[key] = value;
}

function samePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
