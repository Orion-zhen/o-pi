import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { editWorkspace } from "../../src/file-tools/edit-tool.js";
import { readWorkspaceFile } from "../../src/file-tools/read-tool.js";
import type { EditParams, ReadParams } from "../../src/file-tools/types.js";

const readParameters = {
	type: "object",
	properties: {
		path: { type: "string", description: "Workspace-relative file path." },
		start_line: { type: "number", description: "Optional 1-based inclusive start line." },
		end_line: { type: "number", description: "Optional 1-based inclusive end line." },
	},
	required: ["path"],
	additionalProperties: false,
} as const;

const editParameters = {
	type: "object",
	properties: {
		operations: {
			type: "array",
			minItems: 1,
			description: "Structured file operations applied as one transaction.",
			items: {
				oneOf: [
					{
						type: "object",
						properties: {
							type: { const: "create_file" },
							path: { type: "string", description: "Workspace-relative new file path." },
							content: { type: "string", description: "Complete file content to create." },
						},
						required: ["type", "path", "content"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: {
							type: { const: "update_file" },
							path: { type: "string", description: "Workspace-relative existing file path." },
							base_version: { type: "string", description: "Version returned by read for this file." },
							diff: {
								type: "string",
								description:
									"Single-file Codex-style context diff. Use @@ hunks, space context, - removals, + additions. No file headers or paths.",
							},
						},
						required: ["type", "path", "base_version", "diff"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: {
							type: { const: "replace_file" },
							path: { type: "string", description: "Workspace-relative existing file path." },
							base_version: { type: "string", description: "Version returned by read for this file." },
							content: { type: "string", description: "Complete replacement file content." },
						},
						required: ["type", "path", "base_version", "content"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: {
							type: { const: "delete_file" },
							path: { type: "string", description: "Workspace-relative existing file path." },
							base_version: { type: "string", description: "Version returned by read for this file." },
						},
						required: ["type", "path", "base_version"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: {
							type: { const: "move_file" },
							from: { type: "string", description: "Workspace-relative existing source file path." },
							to: { type: "string", description: "Workspace-relative new target file path." },
							base_version: { type: "string", description: "Version returned by read for the source file." },
						},
						required: ["type", "from", "to", "base_version"],
						additionalProperties: false,
					},
				],
			},
		},
	},
	required: ["operations"],
	additionalProperties: false,
} as const;

/** 注册覆盖版 read/edit；工具启用状态由 active-tools.ts 独立扩展处理。 */
export default function fileTools(pi: ExtensionAPI): void {
	pi.registerTool<ReadParams>({
		name: "read",
		label: "read",
		description:
			"Read one UTF-8 workspace file without side effects. Returns content, line range, SHA-256 version, encoding, newline and truncation metadata.",
		promptSnippet: "Read a UTF-8 workspace file and return content plus version metadata",
		promptGuidelines: [
			"Use read before editing an existing file; pass the returned version as that operation's base_version.",
			"If edit returns STALE_BASE_VERSION or DIFF_CONTEXT_*, call read again and generate a new operation.",
		],
		parameters: readParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await readWorkspaceFile(ctx.cwd, params);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool<EditParams>({
		name: "edit",
		label: "edit",
		description:
			"Atomically apply structured file operations. Existing files require the version returned by read. Use update_file for local changes and replace_file for complete replacement.",
		promptSnippet: "Apply structured file operations as one all-or-nothing transaction",
		promptGuidelines: [
			"Use edit as the only file modification tool; it accepts only an operations array.",
			"Use create_file only for new files and replace_file only for existing files.",
		],
		parameters: editParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await editWorkspace(ctx.cwd, params);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});
}
