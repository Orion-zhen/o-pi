import {
	createLocalBashOperations,
	createLocalPowerShellOperations,
	type BashToolDetails as PiBashToolDetails,
	type ExtensionAPI,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createToolRegistrar, type ToolTelemetrySink } from "../register-tool.ts";
import { DEFAULT_SHELL_TOOL, SUPPORTED_SHELL_TOOLS } from "../shell-runtime/platform.ts";
import { takeShellCall } from "../shell-runtime/prepare.ts";
import { executeShellCommand } from "../shell-tools/execute.ts";
import { shellOutputSchema } from "../shell-tools/structured-output.ts";
import { shellTelemetry } from "../shell-tools/telemetry.ts";
import type { ShellToolDetails } from "../shell-tools/types.ts";

const shellParameters = Type.Object(
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

export default function shellTools(pi: ExtensionAPI, telemetry?: ToolTelemetrySink): void {
	const registerTool = createToolRegistrar(pi, telemetry);
	for (const name of SUPPORTED_SHELL_TOOLS) {
		const operations = name === "bash" ? createLocalBashOperations() : createLocalPowerShellOperations();
		registerTool<typeof shellParameters, NativeShellDetails | undefined>({
			tool: {
				name, label: name,
				defaultActive: name === DEFAULT_SHELL_TOOL,
				description: `Run commands in ${name}.`,
				promptSnippet: `run commands in ${name}`,
				promptGuidelines: [`Use ${name} only when no dedicated tool applies.`],
				parameters: shellParameters,
				outputSchema: shellOutputSchema,
				executionMode: "sequential",
				async execute(toolCallId, params, signal, onUpdate, ctx) {
					const prepared = await takeShellCall(name, params, ctx, signal);
					const result = await executeShellCommand(prepared, {
						toolCallId, operations,
						...(signal !== undefined ? { signal } : {}),
						...(onUpdate ? { onUpdate: (text) => onUpdate({ content: [{ type: "text", text }], details: undefined }) } : {}),
					});
					return {
						content: [{ type: "text", text: result.content }],
						details: withNativeShellDetails(result.details),
						structuredContent: result.structuredContent,
						isError: result.details.status !== "exited" || result.details.exit_code !== 0,
					};
				},
			},
			repair: { singleStringField: "command" },
			telemetry: shellTelemetry,
		});
	}
}

type NativeShellDetails = ShellToolDetails & PiBashToolDetails;

function withNativeShellDetails(details: ShellToolDetails): NativeShellDetails {
	const result: NativeShellDetails = { ...details };
	if (details.full_output_path !== undefined) result.fullOutputPath = details.full_output_path;
	if (details.full_output_error !== undefined) result.fullOutputError = details.full_output_error;
	if (details.output_state === "truncated" || details.output_state === "capture_truncated") {
		result.truncation = pseudoTruncation(details);
	}
	return result;
}

function pseudoTruncation(details: ShellToolDetails): TruncationResult {
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
