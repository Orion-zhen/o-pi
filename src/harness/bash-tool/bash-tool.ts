import { createExecutionEnvironment } from "./environment.ts";
import { BASH_STRUCTURED_BYTES, bashStructuredOutput } from "./structured-output.ts";
import { OutputCapture, limitCapturedPreview } from "./output-capture.ts";
import { cleanForModel, createBashOutputView } from "./output-view.ts";
import { resolveBashSkillPaths } from "./skill-paths.ts";
import { takeTailBytes } from "./utf8.ts";
import type { SkillResourceError } from "../skill-context/resources.ts";
import type { BashExecutionResult, BashParams, BashRunStatus, ExecuteBashRuntime } from "./types.ts";

const UPDATE_THROTTLE_MS = 100;

/** 执行模型提供的 shell 命令。 */
export async function executeBashCommand(params: BashParams, runtime: ExecuteBashRuntime): Promise<BashExecutionResult> {
	const skillPaths = await resolveBashSkillPaths(params.command, runtime.branch, runtime.signal);
	if (skillPaths.kind === "error") return skillResourceErrorResult(skillPaths);
	const env = await createExecutionEnvironment(runtime.cwd, runtime.session, runtime.config);
	const { limits } = runtime.config;
	const outputBudget = Math.max(limits.success_output_bytes, limits.failure_output_bytes);
	const modelPreviewBytes = Math.max(outputBudget * 4, limits.live_output_bytes * 2);
	const startedAt = Date.now();
	const capture = await OutputCapture.create({
		sessionId: runtime.session.sessionId,
		toolCallId: runtime.toolCallId,
		maxCaptureBytes: limits.max_capture_bytes,
		previewBytes: Math.max(BASH_STRUCTURED_BYTES, modelPreviewBytes),
	});
	const timeout = params.timeout ?? runtime.config.default_timeout_seconds;

	const onUpdate = runtime.onUpdate;
	let updateTimer: NodeJS.Timeout | undefined;
	let lastUpdateAt = 0;
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
		let status: BashRunStatus = "exited";
		let exitCode: number | undefined;
		let shellExitAfterSeconds: number | undefined;
		try {
			const result = await runtime.operations.exec(skillPaths.command, runtime.cwd, {
				onData(data) {
					capture.append(data);
					scheduleUpdate();
				},
				...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
				timeout,
				env,
			});
			exitCode = result.exitCode ?? undefined;
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			if (error.message === "aborted") status = "aborted";
			else if (error.message === `timeout:${timeout}`) {
				status = "timed_out";
				// SDK 未导出超时错误类型，按本地后端契约读取可选诊断。
				const { shellExit } = error as Error & { shellExit?: { exitCode: number; afterSeconds: number } };
				exitCode = shellExit?.exitCode;
				shellExitAfterSeconds = shellExit?.afterSeconds;
			} else throw error;
		} finally {
			clearUpdateTimer();
		}
		const captured = await capture.finish();
		const view = createBashOutputView({
			...captured,
			preview: limitCapturedPreview(captured.preview, modelPreviewBytes),
			status,
			...(exitCode !== undefined ? { exitCode } : {}),
			...(shellExitAfterSeconds !== undefined ? { shellExitAfterSeconds } : {}),
			durationMs: Date.now() - startedAt,
			limits,
		});
		const structuredContent = bashStructuredOutput(captured, view.details);
		const keepLog = view.keepLog || structuredContent.truncated;
		if (!keepLog) await capture.deleteLog();
		return {
			content: view.content,
			details: keepLog ? { ...view.details, full_output_path: captured.logPath } : view.details,
			structuredContent: keepLog ? { ...structuredContent, full_output_path: captured.logPath } : structuredContent,
		};
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
		structuredContent: {
			output: error.message, status: "exited", exit_code: 126,
			wall_time_seconds: 0, truncated: false, capture_complete: true,
		},
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
