import { createLocalBashOperations, type ExtensionAPI, type ToolResultEvent, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { executeBashCommand } from "../../src/bash-tool/bash-tool.js";
import { loadBashToolConfig } from "../../src/bash-tool/config.js";
import type { BashSessionMetadata, BashToolDetails } from "../../src/bash-tool/types.js";
import { bashTelemetry } from "../../src/bash-tool/telemetry.js";
import { registerObservedTool } from "../../src/telemetry/tool.js";

const bashParameters = Type.Object({
	command: Type.String({ description: "Shell command; default runs in workspace." }),
	timeout: Type.Optional(Type.Number({
		description: "Seconds.",
		exclusiveMinimum: 0,
		maximum: 86_400,
	})),
}, { additionalProperties: false });

/** 注册覆盖版 bash。执行后端用 Pi 本地 shell，输出管理由本项目控制。 */
export default function bashTool(pi: ExtensionAPI): void {
	const operations = createLocalBashOperations();
	const tool = registerObservedTool<typeof bashParameters, NativeBashDetails | undefined, unknown>(pi, {
		tool: {
			name: "bash",
			label: "bash",
			description: "Run commands in bash.",
			promptSnippet: "run commands in bash",
			promptGuidelines: ["Use bash only for operations not covered by active dedicated tools."],
			parameters: bashParameters,
			executionMode: "sequential",
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const config = await loadBashToolConfig();
				const sessionFile = ctx.sessionManager.getSessionFile();
				const session: BashSessionMetadata = {
					sessionId: ctx.sessionManager.getSessionId(),
					...(sessionFile !== undefined ? { sessionFile } : {}),
					...(ctx.model !== undefined ? { provider: ctx.model.provider, model: ctx.model.id } : {}),
					...(ctx.thinkingLevel !== undefined ? { reasoningLevel: ctx.thinkingLevel } : {}),
				};
				const runtime = {
					cwd: ctx.cwd,
					session,
					toolCallId,
					operations,
					config,
					branch: ctx.sessionManager.getBranch(),
					...(signal !== undefined ? { signal } : {}),
					...(onUpdate
						? {
								onUpdate: (content: string) => {
									onUpdate({ content: [{ type: "text", text: content }], details: undefined });
								},
							}
						: {}),
				};
				const result = await executeBashCommand(params, runtime);
				return { content: [{ type: "text", text: result.content }], details: withNativeBashDetails(result.details) };
			},
		},
		repair: { singleStringField: "command" },
		telemetry: bashTelemetry,
	});

	let rendererLoad: Promise<void> | undefined;
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		rendererLoad ??= import("../../src/bash-tool/tui/renderer.js").then(({ renderBashCall }) => {
			pi.registerTool({ ...tool, renderCall: renderBashCall });
		});
		await rendererLoad;
	});

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
