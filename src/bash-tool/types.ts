import type { BashOperations } from "@earendil-works/pi-coding-agent";

export interface BashParams {
	command: string;
	timeout?: number;
}

export interface BashLimits {
	success_output_bytes: number;
	failure_output_bytes: number;
	live_output_bytes: number;
	max_capture_bytes: number;
}

export interface BashToolConfig {
	version: 1;
	default_timeout_seconds: number;
	limits: BashLimits;
	safety?: {
		deny_patterns?: string[];
		deny_regex?: string[];
	};
}

export type BashRunStatus = "exited" | "timed_out" | "aborted";
export type BashOutputState = "complete" | "compacted" | "truncated" | "capture_truncated";
export type BashOutputFormat = "text" | "json" | "xml" | "diff" | "binary";

/** Bash 工具返回给模型和 UI 的稳定执行元数据。 */
export interface BashToolDetails {
	status: BashRunStatus;
	exit_code?: number;
	duration_ms: number;
	output_state: BashOutputState;
	output_format: BashOutputFormat;
	total_lines: number;
	returned_lines: number;
	total_bytes: number;
	returned_bytes: number;
	full_output_path?: string;
	capture_complete: boolean;
}

export interface BashExecutionResult {
	content: string;
	details: BashToolDetails;
}

export interface ExecuteBashRuntime {
	cwd: string;
	sessionId: string;
	toolCallId: string;
	signal?: AbortSignal;
	operations: BashOperations;
	config: BashToolConfig;
	onUpdate?: (result: BashExecutionResult) => void;
	now?: () => number;
}

export interface CapturedOutput {
	previewText: string;
	totalBytes: number;
	totalLines: number;
	logPath: string;
	captureComplete: boolean;
	binary: boolean;
}
