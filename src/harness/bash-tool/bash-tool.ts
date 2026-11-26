import { withAskpass } from "../bash-runtime/askpass.ts";
import type { PreparedBashCommand } from "../bash-runtime/prepare.ts";
import { BASH_STRUCTURED_BYTES, bashStructuredPreview } from "./structured-output.ts";
import { OutputCapture, limitCapturedPreview } from "./output-capture.ts";
import { cleanForModel, createBashOutputView } from "./output-view.ts";
import { takeTailBytes } from "./utf8.ts";
import type { SkillResourceError } from "../skill-context/resources.ts";
import type { BashExecutionResult, BashRunStatus, ExecuteBashRuntime } from "./types.ts";

const UPDATE_THROTTLE_MS = 100;

export async function executeBashCommand(prepared: PreparedBashCommand, runtime: ExecuteBashRuntime): Promise<BashExecutionResult> {
	if (prepared.kind === "error") return skillResourceErrorResult(prepared);
	const { limits, timeout } = prepared;
	const outputBudget = Math.max(limits.success_output_bytes, limits.failure_output_bytes);
	const modelPreviewBytes = Math.max(outputBudget * 4, limits.live_output_bytes * 2);
	const startedAt = Date.now();
	const capture = await OutputCapture.create({
		sessionId: prepared.sessionId,
		toolCallId: runtime.toolCallId,
		maxCaptureBytes: limits.max_capture_bytes,
		previewBytes: Math.max(BASH_STRUCTURED_BYTES, modelPreviewBytes),
	});

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
			const operations = prepared.askpass ? withAskpass(runtime.operations, prepared.askpass) : runtime.operations;
			const result = await operations.exec(prepared.command, prepared.cwd, {
				onData(data) {
					capture.append(data);
					scheduleUpdate();
				},
				...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
				timeout,
				env: prepared.env,
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
		const script = bashStructuredPreview(captured.preview);
		const view = createBashOutputView({
			...captured,
			preview: limitCapturedPreview(captured.preview, modelPreviewBytes),
			status,
			...(exitCode !== undefined ? { exitCode } : {}),
			...(shellExitAfterSeconds !== undefined ? { shellExitAfterSeconds } : {}),
			durationMs: Date.now() - startedAt,
			limits,
		}, script.truncated);
		if (!view.keepLog && "full_output_path" in captured.log) await capture.deleteLog();
		return {
			content: view.content,
			details: view.details,
			structuredContent: {
				...script, status, exit_code: exitCode ?? null, wall_time_seconds: view.details.duration_ms / 1000,
				...(shellExitAfterSeconds === undefined ? {} : { shell_exit_after_seconds: shellExitAfterSeconds }),
				capture_complete: captured.captureComplete,
				...(view.keepLog ? captured.log : {}),
			},
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
