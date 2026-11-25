import type { BashStructuredOutput } from "./structured-output.ts";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

export type BashRunStatus = "exited" | "timed_out" | "aborted";
export type BashOutputState = "complete" | "compacted" | "truncated" | "capture_truncated";
export type BashOutputFormat = "text" | "json" | "xml" | "diff" | "binary";

/** Bash 工具返回给模型和 UI 的稳定执行元数据。 */
export interface BashToolDetails {
	status: BashRunStatus;
	exit_code?: number;
	shell_exit_after_seconds?: number;
	duration_ms: number;
	output_state: BashOutputState;
	output_format: BashOutputFormat;
	total_lines: number;
	returned_lines: number;
	total_bytes: number;
	returned_bytes: number;
	full_output_path?: string;
	full_output_error?: string;
	capture_complete: boolean;
}

export interface BashExecutionResult {
	content: string;
	details: BashToolDetails;
	structuredContent: BashStructuredOutput;
}

export interface ExecuteBashRuntime {
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
