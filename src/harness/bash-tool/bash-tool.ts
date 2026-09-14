import { createExecutionEnvironment } from "./environment.js";
import { OutputCapture } from "./output-capture.js";
import { cleanForModel, createBashOutputView } from "./output-view.js";
import { resolveBashSkillPaths } from "./skill-paths.js";
import { takeTailBytes } from "./utf8.js";
import type { SkillResourceError } from "../skill-context/resources.js";
import type { BashExecutionResult, BashParams, ExecuteBashRuntime } from "./types.js";

const UPDATE_THROTTLE_MS = 100;

/** 执行模型提供的 shell 命令。 */
export async function executeBashCommand(params: BashParams, runtime: ExecuteBashRuntime): Promise<BashExecutionResult> {
	const skillPaths = await resolveBashSkillPaths(params.command, runtime.branch, runtime.signal);
	if (skillPaths.kind === "error") return skillResourceErrorResult(skillPaths);
	const env = await createExecutionEnvironment(runtime.cwd, runtime.session, runtime.config);
	const { limits } = runtime.config;
	const outputBudget = Math.max(limits.success_output_bytes, limits.failure_output_bytes);
	const startedAt = Date.now();
	const capture = await OutputCapture.create({
		sessionId: runtime.session.sessionId,
		toolCallId: runtime.toolCallId,
		maxCaptureBytes: limits.max_capture_bytes,
		previewBytes: Math.max(outputBudget * 4, limits.live_output_bytes * 2),
	});
	const controller = new AbortController();
	let stopReason: "timeout" | "aborted" | undefined;
	const stop = (reason: "timeout" | "aborted") => {
		if (controller.signal.aborted) return;
		stopReason = reason;
		controller.abort();
	};
	const abortFromUser = () => stop("aborted");
	if (runtime.signal?.aborted) abortFromUser();
	runtime.signal?.addEventListener("abort", abortFromUser, { once: true });
	const timeoutTimer = setTimeout(() => stop("timeout"), (params.timeout ?? runtime.config.default_timeout_seconds) * 1000);

	const onUpdate = runtime.onUpdate;
	let updateTimer: NodeJS.Timeout | undefined;
	let lastUpdateAt = 0;
	let acceptingOutput = true;
	const clearUpdateTimer = () => {
		clearTimeout(updateTimer);
		updateTimer = undefined;
	};
	const emitUpdate = () => {
		lastUpdateAt = Date.now();
		const live = takeTailBytes(cleanForModel(capture.liveText(limits.live_output_bytes), "text").text, limits.live_output_bytes);
		onUpdate?.(`[running ${((lastUpdateAt - startedAt) / 1000).toFixed(1)}s]${live ? `\n\n${live}` : ""}`);
	};
	const scheduleUpdate = () => {
		if (onUpdate === undefined) return;
		const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
		if (delay <= 0) {
			clearUpdateTimer();
			emitUpdate();
		} else {
			updateTimer ??= setTimeout(() => {
				updateTimer = undefined;
				emitUpdate();
			}, delay);
		}
	};

	try {
		let exitCode: number | undefined;
		try {
			const result = await runtime.operations.exec(skillPaths.command, runtime.cwd, {
				onData(data) {
					if (!acceptingOutput) return;
					capture.append(data);
					scheduleUpdate();
				},
				signal: controller.signal,
				env,
			});
			exitCode = result.exitCode ?? undefined;
		} catch (error) {
			if (stopReason === undefined) throw error;
		} finally {
			acceptingOutput = false;
			clearUpdateTimer();
			clearTimeout(timeoutTimer);
			runtime.signal?.removeEventListener("abort", abortFromUser);
		}
		const captured = await capture.finish();
		const view = createBashOutputView({
			...captured,
			status: stopReason === "timeout" ? "timed_out" : stopReason === "aborted" ? "aborted" : "exited",
			...(exitCode !== undefined ? { exitCode } : {}),
			durationMs: Date.now() - startedAt,
			limits,
		});
		if (!view.keepLog) await capture.deleteLog();
		return { content: view.content, details: view.details };
	} catch (error) {
		await capture.discard().catch(() => undefined);
		throw error;
	}
}

function skillResourceErrorResult(error: SkillResourceError): BashExecutionResult {
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

function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
