import {
	createLocalBashOperations,
	type BashToolDetails as PiBashToolDetails,
	type ExtensionAPI,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { bashOutputSchema } from "../bash-tool/structured-output.ts";
import { executeBashCommand } from "../bash-tool/bash-tool.ts";
import { takeBashCall } from "../bash-runtime/prepare.ts";
import type { BashToolDetails } from "../bash-tool/types.ts";
import { bashTelemetry } from "../bash-tool/telemetry.ts";
import { createToolRegistrar, type ToolTelemetrySink } from "../register-tool.ts";

const bashParameters = Type.Object(
	{
		command: Type.String({ description: "Shell command." }),
		timeout: Type.Optional(
			Type.Number({
				description: "Seconds.",
				exclusiveMinimum: 0,
				maximum: 86_400,
			}),
		),
		workdir: Type.Optional(Type.String({ description: "Working directory; defaults to current workspace." })),
	},
	{ additionalProperties: false },
);

/** 注册覆盖版 bash。执行后端用 Pi 本地 shell，输出管理由本项目控制。 */
export default function bashTool(pi: ExtensionAPI, telemetry?: ToolTelemetrySink): void {
	const registerTool = createToolRegistrar(pi, telemetry);
	const operations = createLocalBashOperations();
	registerTool<typeof bashParameters, NativeBashDetails | undefined, unknown>({
		tool: {
			name: "bash",
			label: "bash",
			description: "Run commands in bash.",
			promptSnippet: "run commands in bash",
			promptGuidelines: ["Use bash only when no dedicated tool applies."],
			parameters: bashParameters,
			outputSchema: bashOutputSchema,
			executionMode: "sequential",
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const prepared = await takeBashCall(params, ctx, signal);
				const result = await executeBashCommand(prepared, {
					toolCallId, operations,
					...(signal !== undefined ? { signal } : {}),
					...(onUpdate
						? {
								onUpdate: (content: string) => {
									onUpdate({ content: [{ type: "text", text: content }], details: undefined });
								},
							}
						: {}),
				});
				return {
					content: [{ type: "text", text: result.content }],
					details: withNativeBashDetails(result.details),
					structuredContent: result.structuredContent,
					isError: result.details.status !== "exited" || result.details.exit_code !== 0,
				};
			},
		},
		repair: { singleStringField: "command" },
		telemetry: bashTelemetry,
	});
}

type NativeBashDetails = BashToolDetails & PiBashToolDetails;

function withNativeBashDetails(details: BashToolDetails): NativeBashDetails {
	const result: NativeBashDetails = { ...details };
	if (details.full_output_path !== undefined) result.fullOutputPath = details.full_output_path;
	if (details.full_output_error !== undefined) result.fullOutputError = details.full_output_error;
	if (details.output_state === "truncated" || details.output_state === "capture_truncated") {
		result.truncation = pseudoBashTruncation(details);
	}
	return result;
}

function pseudoBashTruncation(details: BashToolDetails): TruncationResult {
	return {
		content: "",
		truncated: true,
		truncatedBy: "bytes",
		totalLines: Math.max(details.total_lines, details.returned_lines),
		totalBytes: Math.max(details.total_bytes, details.returned_bytes),
		outputLines: details.returned_lines,
		outputBytes: details.returned_bytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines: details.returned_lines,
		maxBytes: details.returned_bytes,
	};
}
