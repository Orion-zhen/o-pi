import { fields, textFields } from "../telemetry/projection.ts";
import type { ToolTelemetry } from "../telemetry/types.ts";
import type { ShellParams } from "../shell-runtime/prepare.ts";
import type { ShellToolDetails } from "./types.ts";

export const shellTelemetry = {
	input(params) {
		return {
			fields: fields({
				input_timeout_seconds: params.timeout,
				...textFields("input_command", params.command),
			}),
		};
	},
	result(_params, details) {
		return {
			fields: fields({
				status: details.status,
				exit_code: details.exit_code,
				output_state: details.output_state,
				output_format: details.output_format,
				capture_complete: details.capture_complete,
				total_line_count: details.total_lines,
				returned_line_count: details.returned_lines,
				total_size_bytes: details.total_bytes,
				returned_size_bytes: details.returned_bytes,
				truncated: details.output_state === "truncated" || details.output_state === "capture_truncated",
			}),
		};
	},
} satisfies ToolTelemetry<ShellParams, ShellToolDetails>;
