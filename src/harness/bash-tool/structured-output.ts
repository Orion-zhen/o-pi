import { Type, type Static } from "typebox";
import type { BashToolDetails, CapturedOutput } from "./types.ts";
import { decodeUtf8Prefix, takeHeadBytes, takeTailBytes, trimLeadingUtf8Continuation } from "./utf8.ts";

export const BASH_STRUCTURED_BYTES = 1024 * 1024;
export const bashOutputSchema = Type.Object({
	output: Type.String(),
	status: Type.Union([Type.Literal("exited"), Type.Literal("timed_out"), Type.Literal("aborted")]),
	exit_code: Type.Union([Type.Integer(), Type.Null()]),
	wall_time_seconds: Type.Number(),
	truncated: Type.Boolean(),
	capture_complete: Type.Boolean(),
	full_output_path: Type.Optional(Type.String()),
});

export type BashStructuredOutput = Static<typeof bashOutputSchema>;

/** 脚本读取原始文本，独立于模型摘要。超过预算只保留 UTF-8 完整的头尾。 */
export function bashStructuredOutput(captured: CapturedOutput, details: BashToolDetails): BashStructuredOutput {
	const preview = captured.preview;
	const marker = "\n[output omitted]\n";
	const budget = Math.floor((BASH_STRUCTURED_BYTES - Buffer.byteLength(marker)) / 2);
	const head = preview.kind === "complete" ? preview.bytes.toString("utf8") : decodeUtf8Prefix(preview.head);
	const truncated = preview.kind === "split" || Buffer.byteLength(head) > BASH_STRUCTURED_BYTES;
	const tail = preview.kind === "complete" ? head : trimLeadingUtf8Continuation(preview.tail).toString("utf8");
	return {
		output: truncated ? takeHeadBytes(head, budget) + marker + takeTailBytes(tail, budget) : head,
		status: details.status,
		exit_code: details.exit_code ?? null,
		wall_time_seconds: details.duration_ms / 1000,
		truncated,
		capture_complete: captured.captureComplete,
		...(details.full_output_path === undefined ? {} : { full_output_path: details.full_output_path }),
	};
}
