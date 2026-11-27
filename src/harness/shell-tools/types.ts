import type { ShellStructuredOutput } from "./structured-output.ts";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

export type ShellRunStatus = "exited" | "timed_out" | "aborted";
export type ShellOutputState = "complete" | "compacted" | "truncated" | "capture_truncated";
export type ShellOutputFormat = "text" | "json" | "xml" | "diff" | "binary";

/** Shell 工具返回给模型和 UI 的稳定执行元数据。 */
export interface ShellToolDetails {
	status: ShellRunStatus;
	exit_code?: number;
	shell_exit_after_seconds?: number;
	duration_ms: number;
	output_state: ShellOutputState;
	output_format: ShellOutputFormat;
	total_lines: number;
	returned_lines: number;
	total_bytes: number;
	returned_bytes: number;
	full_output_path?: string;
	full_output_error?: string;
	capture_complete: boolean;
}

export interface ShellExecutionResult {
	content: string;
	details: ShellToolDetails;
	structuredContent: ShellStructuredOutput;
}

export interface ExecuteShellRuntime {
	toolCallId: string;
	signal?: AbortSignal;
	operations: BashOperations;
	onUpdate?: (content: string) => void;
}

export type CapturedPreview =
	| { kind: "complete"; bytes: Buffer }
	| { kind: "split"; head: Buffer; tail: Buffer; omittedBytes: number };

export interface CapturedOutput {
	preview: CapturedPreview;
	totalBytes: number;
	totalLines: number;
	log: { full_output_path: string } | { full_output_error: string };
	captureComplete: boolean;
	binary: boolean;
}
