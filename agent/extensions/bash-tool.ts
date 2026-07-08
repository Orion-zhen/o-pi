import type { ExtensionAPI, ToolResultEvent, TruncationResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	createDefaultBashOperations,
	executeBashCommand,
	loadBashToolConfig,
	type BashExecutionResult,
	type BashParams,
	type BashToolDetails,
} from "../../src/bash-tool/index.js";
import { repairableTool } from "../../src/tool-repair/index.js";

const bashParameters = Type.Object({
	command: Type.String({ description: "Shell command to execute exactly as provided." }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds. Defaults to config." })),
}, { additionalProperties: false });

/** 注册覆盖版 bash；执行后端用 Pi 本地 shell，输出管理由本项目控制。 */
export default function bashTool(pi: ExtensionAPI): void {
	const operations = createDefaultBashOperations();

	pi.registerTool(repairableTool({
		name: "bash",
		label: "bash",
		description: "Run shell commands or external programs; use dedicated tools for direct file listing, search, reading, and edits.",
		promptSnippet: "run shell commands or external programs",
		promptGuidelines: [
			"When a dedicated tool and bash can both perform an operation, use the dedicated tool unless shell execution itself is the task.",
			"Use bash for tests, builds, formatters, compilers, generators, git, and other external programs; files changed by those programs remain bash output.",
		],
		parameters: bashParameters,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const config = await loadBashToolConfig();
			const runtime = {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				toolCallId,
				operations,
				config,
				...(signal !== undefined ? { signal } : {}),
				...(onUpdate
					? {
							onUpdate: (partial: BashExecutionResult) => {
								onUpdate({ content: [{ type: "text", text: partial.content }], details: withNativeBashDetails(partial.details) });
							},
						}
					: {}),
			};
			const result = await executeBashCommand(params as BashParams, runtime);
			return { content: [{ type: "text", text: result.content }], details: withNativeBashDetails(result.details) };
		},
	}, { singleStringField: "command" }));

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash" || !isBashDetails(event.details)) return undefined;
		if (event.details.status !== "exited" || event.details.exit_code !== 0) {
			return { isError: true };
		}
		return undefined;
	});
}

function isBashDetails(value: ToolResultEvent["details"]): value is BashToolDetails {
	return (
		typeof value === "object" &&
		value !== null &&
		"status" in value &&
		"duration_ms" in value &&
		"output_state" in value &&
		"capture_complete" in value
	);
}

type NativeBashDetails = BashToolDetails & {
	/** Pi 内置 bash renderer 识别的输出截断摘要。 */
	truncation?: TruncationResult;
	/** Pi 内置 bash renderer 识别的完整输出日志路径。 */
	fullOutputPath?: string;
};

function withNativeBashDetails(details: BashToolDetails): NativeBashDetails {
	const result: NativeBashDetails = { ...details };
	if (details.full_output_path !== undefined) result.fullOutputPath = details.full_output_path;
	if (details.output_state === "truncated" || details.output_state === "capture_truncated") {
		result.truncation = pseudoBashTruncation(details);
	}
	return result;
}

function pseudoBashTruncation(details: BashToolDetails): TruncationResult {
	const truncatedBy = details.returned_bytes < details.total_bytes ? "bytes" : "lines";
	return {
		content: "",
		truncated: true,
		truncatedBy,
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
