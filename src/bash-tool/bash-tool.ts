import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

import { OutputCapture } from "./output-capture.js";
import { cleanForModel, createBashOutputView } from "./output-view.js";
import type { BashExecutionResult, BashParams, ExecuteBashRuntime } from "./types.js";

const UPDATE_THROTTLE_MS = 100;

/** 执行模型提供的 shell 命令；自动将 Windows 反斜杠路径转为正斜杠。 */
export async function executeBashCommand(params: BashParams, runtime: ExecuteBashRuntime): Promise<BashExecutionResult> {
	validateParams(params, runtime.config.default_timeout_seconds);
	params = { ...params, command: normalizeWindowsPath(params.command) };
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

export function createDefaultBashOperations() {
	return createLocalBashOperations();
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
