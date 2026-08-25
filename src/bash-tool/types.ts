import type { BashOperations, SessionEntry } from "@earendil-works/pi-coding-agent";

export interface BashParams {
	command: string;
	timeout?: number;
}

export interface BashEnvironmentConfig {
	inherit: boolean;
	remove_name_regex: string[];
	expose_pi_session_file: boolean;
}

export interface BashLimits {
	success_output_bytes: number;
	failure_output_bytes: number;
	live_output_bytes: number;
	max_capture_bytes: number;
}

export interface BashToolConfig {
	default_timeout_seconds: number;
	python_venv_paths: string[];
	environment: BashEnvironmentConfig;
	limits: BashLimits;
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

export interface BashSessionMetadata {
	sessionId: string;
	sessionFile?: string;
	provider?: string;
	model?: string;
	reasoningLevel?: string;
}

export interface ExecuteBashRuntime {
	cwd: string;
	session: BashSessionMetadata;
	toolCallId: string;
	signal?: AbortSignal;
	operations: BashOperations;
	config: BashToolConfig;
	branch: SessionEntry[];
	onUpdate?: (result: BashExecutionResult) => void;
}

export interface CapturedOutput {
	previewText: string;
	totalBytes: number;
	totalLines: number;
	logPath: string;
	captureComplete: boolean;
	binary: boolean;
}
