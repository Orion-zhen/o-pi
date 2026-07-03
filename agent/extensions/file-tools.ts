import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { editWorkspace } from "../../src/file-tools/edit-tool.js";
import { listWorkspaceDirectory } from "../../src/file-tools/ls-tool.js";
import { readWorkspaceFile } from "../../src/file-tools/read-tool.js";
import type { EditParams, LsParams, ReadParams } from "../../src/file-tools/types.js";

const lsParameters = Type.Object({ path: Type.String({ description: "Directory path." }) });
const readParameters = Type.Object({
	path: Type.String({ description: "File path." }),
	start_line: Type.Optional(Type.Number({ description: "Optional 1-based inclusive start line." })),
	end_line: Type.Optional(Type.Number({ description: "Optional 1-based inclusive end line." })),
});
const editParameters = Type.Object({
	operations: Type.Array(
		Type.Union([
			Type.Object({ type: Type.Literal("create_file"), path: Type.String(), content: Type.String() }),
			Type.Object({ type: Type.Literal("update_file"), path: Type.String(), base_version: Type.String(), diff: Type.String() }),
			Type.Object({ type: Type.Literal("replace_file"), path: Type.String(), base_version: Type.String(), content: Type.String() }),
			Type.Object({ type: Type.Literal("delete_file"), path: Type.String(), base_version: Type.String() }),
			Type.Object({ type: Type.Literal("move_file"), from: Type.String(), to: Type.String(), base_version: Type.String() }),
		]),
		{ minItems: 1, description: "Structured file operations applied as one transaction." },
	),
});

/** 注册覆盖版 ls/read/edit；路径权限由 Pi 进程和操作系统决定。 */
export default function fileTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ls",
		label: "ls",
		description: "List the direct children of a directory. The result is non-recursive and does not include file contents.",
		promptSnippet: "List direct children of a directory",
		promptGuidelines: ["Use ls to discover directory contents before choosing files to read.", "The .git directory is hidden."],
		parameters: lsParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await listWorkspaceDirectory(ctx.cwd, params as LsParams);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "read",
		label: "read",
		description:
			"Read one UTF-8 file without side effects. Returns content, line range, SHA-256 version, encoding, newline and truncation metadata.",
		promptSnippet: "Read a UTF-8 file and return content plus version metadata",
		promptGuidelines: [
			"Use read before editing an existing file; pass the returned version as that operation's base_version.",
			"If edit returns STALE_BASE_VERSION or DIFF_CONTEXT_*, call read again and generate a new operation.",
			"Do not read .git paths.",
		],
		parameters: readParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await readWorkspaceFile(ctx.cwd, params as ReadParams);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Atomically apply structured file operations. Existing files require the version returned by read. Use update_file for local changes and replace_file for complete replacement.",
		promptSnippet: "Apply structured file operations as one all-or-nothing transaction",
		promptGuidelines: [
			"Use edit as the only file modification tool; it accepts only an operations array.",
			"Use create_file only for new files and replace_file only for existing files.",
			"Do not edit .git paths.",
		],
		parameters: editParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await editWorkspace(ctx.cwd, params as EditParams);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});
}
